# Plan: Caches & Thundering Herds

## Puzzle concept

A **Cache node** sits in front of a **DB node**. Under normal operation the cache absorbs
most traffic (high hit rate), so the DB runs well within its capacity. A `CACHE_FLUSH`
stressor drops the hit rate to zero — every token that would have been served from memory
now punches through to the DB simultaneously. The player must predict that the DB is the
failure point, not the cache (which has plenty of concurrency) and not the entry node.

This teaches the classic thundering herd insight: it's not the spike in *arrival* rate that
kills the system — the global arrival rate is unchanged — it's the sudden elimination of the
absorbing layer that exposes the unprotected DB.

---

## New node subtype

```js
{
  id: 'n2',
  name: 'Product Cache',
  node_subtype: 'cache',       // NEW
  hit_rate: 0.85,              // fraction of tokens served without forwarding downstream
  max_concurrency: 20,
  queue_limit: 40,
  local_latency_ticks: 1,      // cache lookup is fast
}
```

`node_subtype` is otherwise undefined (undefined = normal). Only `'cache'` is introduced here.
The downstream DB node is a regular node with no subtype, but named from `EXIT_NAMES` (or a
new `DB_NAMES` pool: `"Primary DB"`, `"Read Replica"`, `"Postgres"`, `"MySQL Cluster"`).

---

## Simulator changes (`js/simulator.js`)

### Deterministic hit/miss decision

The hit/miss decision must be **deterministic per token** to keep simulations reproducible.
Use a simple hash of the token's integer id (at the cache layer, tokens have IDs like `7`,
`7:n2` etc; use the numeric prefix):

```js
_cache_hit(node_id, token) {
  const def = this.nodes[node_id];
  if (def.node_subtype !== 'cache' || def.hit_rate == null) return false;
  // Extract numeric prefix from token id for stable hashing.
  const num = parseInt(String(token.id).split(':')[0], 10);
  return (num % 1000) < (def.hit_rate * 1000);
}
```

### `_dispatch` modification

After local processing completes, before the normal edge walk:

```js
_dispatch(slot, node_id) {
  // Cache hit: serve from memory, skip all downstream edges.
  if (this._cache_hit(node_id, slot.token)) {
    for (const ack of slot.token.release_acks) ack.done = true;
    return true; // release slot, no sync waits
  }
  // ... existing fan-out logic unchanged ...
}
```

No new event type is needed for cache hits — they're silent successes, which is correct
(the player has no visibility into hit/miss during the scenario).

### No other simulator changes required.

---

## Generator changes (`js/generator.js`)

### New topology: cache–db pair

Add a dedicated topology template that guarantees a cache–db subpath. The simplest approach
is a new **4-node linear topology** where node[2] is forced to be `node_subtype: 'cache'`
and node[3] is the DB:

```
[entry] → [middleware] → [cache] → [db]
```

In `buildTopology`, after picking the template, if it's the cache–db template, post-process
the last two nodes:

```js
if (template === CACHE_DB_TEMPLATE) {
  const cache_node = layers[layers.length - 2][0];
  const db_node    = layers[layers.length - 1][0];
  cache_node.node_subtype        = 'cache';
  cache_node.hit_rate            = (randInt(rng, 75, 92)) / 100;
  cache_node.local_latency_ticks = 1;
  cache_node.max_concurrency     = randInt(rng, 15, 25); // cache is fast, high concurrency
  cache_node.name                = pick(rng, ['Product Cache', 'Query Cache', 'Redis Cache',
                                              'Memcache Layer', 'L2 Cache']);
  db_node.name                   = pick(rng, ['Primary DB', 'Postgres', 'MySQL Cluster',
                                              'Read Replica', 'Datastore']);
  db_node.max_concurrency        = randInt(rng, 3, 6);  // DB is slow, low concurrency
  db_node.local_latency_ticks    = randInt(rng, 8, 16); // DB is expensive
  db_node.queue_limit            = randInt(rng, 10, 18);
}
```

The edge between cache and DB is always **SYNC** (the caller waits for DB result).

This template has a ~15 % selection probability (alongside the existing rare pool logic).

### `assignBuckets` — skip cache nodes

Cache nodes don't get token buckets (they already have a hit-rate filter).

### Stability analysis — account for cache absorption

In `safeArrivalRate`, when computing effective load on each node:

```js
// For cache nodes, only (1 - hit_rate) of tokens reach downstream.
// Apply this as a multiplier on the load factor propagation in computeLoadFactors.
```

The cleanest approach: in `computeLoadFactors`, when propagating from a cache node through
its outgoing edges, multiply the forwarded factor by `(1 - cache_node.hit_rate)`:

```js
const forwarding = (def.node_subtype === 'cache') ? (1 - def.hit_rate) : 1;
factors[e.target_id] += factors[id] * forwarding;
```

This correctly models that under baseline conditions only `(1-hit_rate)` of traffic reaches
the DB.

### New stressor: `CACHE_FLUSH`

Requires at least one `cache` subtype node. Sets `hit_rate = 0`:

```js
} else if (type === 'CACHE_FLUSH') {
  const cache_nodes = nodes.filter(n => n.node_subtype === 'cache');
  const target      = pick(rng, cache_nodes);
  const old_hr      = target.hit_rate;
  nodes.find(n => n.id === target.id).hit_rate = 0;
  description =
    `${target.name} experienced a full cache flush (TTL expiry or invalidation storm). ` +
    `Hit rate: ${Math.round(old_hr * 100)}% → 0%. Every request now reaches the database cold.`;
  mutation = { type, node_id: target.id, property: 'hit_rate',
               old_value: old_hr, new_value: 0 };
}
```

Add `'CACHE_FLUSH'` to `STRESSOR_TYPES`. Gate it on `cache_nodes.length > 0`.

### Quiz answer

`CACHE_FLUSH` causes `QUEUE_DROP` at the DB node (the first node downstream of the cache
whose queue fills under the full throughput). The existing quiz answers cover this — no new
terminal event type is needed.

### `buildExplanation` addition

In the `QUEUE_DROP` branch:

```js
if (stressor.type === 'CACHE_FLUSH') {
  return `${failed_node} was previously protected by the cache absorbing ` +
    `${Math.round(stressor.mutation.old_value * 100)}% of traffic. With the cache flushed, ` +
    `100% of requests hit the database simultaneously — a classic thundering herd. ` +
    `The DB's concurrency limit (${nodes_map[failure.node_id].max_concurrency} slots) ` +
    `was overwhelmed and its queue filled in ${failure.tick} ticks.`;
}
```

---

## Graph / UI changes

### Cache node rendering (`js/graph.js`)

- Cache nodes use a **cylinder shape** instead of the standard rect: draw two ellipses
  (top and bottom) and a rect body connecting them. Keep the same `NODE_W × NODE_H` bounding
  box so the layout math is unchanged.
- Colour: teal/cyan tint (distinct from the stressed purple and normal blue-grey).
- Show **hit rate** below the node name: `hit: 85%` in the same dim style as the quota line.
  After a `CACHE_FLUSH` stressor is applied, the stressed graph shows `hit: 0%`.

### New incident description nuance

The incident panel should make clear that the arrival rate at the entry node is unchanged.
The `description` field from `applyStressor` already carries this, but the system-policy
line should note: `cache: flush (hit 85% → 0%)`.

### No new quiz button needed

`QUEUE_DROP` already exists; the explanation text distinguishes the thundering herd cause.

---

## Test cases

### Simulator tests

1. **Cache hit absorbs load**: configure a [cache → DB] pair with `hit_rate: 1.0`. Send 20
   tokens through cache. Assert DB receives 0 tokens (no slots occupied, queue empty).
2. **Cache miss forwards correctly**: `hit_rate: 0.0`. Send 10 tokens. Assert DB receives
   all 10 (slots/queue fill as expected).
3. **Partial hit rate**: `hit_rate: 0.5`. Send 100 tokens (IDs 0–99). Assert DB receives
   ~50 tokens (within ±5 for deterministic hash distribution).
4. **SYNC ack released on hit**: cache node is called via SYNC edge. On a cache hit, the
   upstream SYNC wait's ack resolves immediately (upstream slot freed without waiting for DB).

### Generator tests

5. **CACHE_FLUSH stressor produces QUEUE_DROP at DB** across 3 seeds with cache–db template.
6. **Baseline is stable with high hit rate**: the DB's load under `hit_rate: 0.85` is
   sustainable at the generated arrival rate.
7. **`computeLoadFactors` respects cache absorption**: DB's load factor = entry's load
   factor × `(1 - hit_rate)`, verified numerically.
8. **Cache nodes never get token buckets**.

---

## Key invariants / gotchas

- **Topology constraint**: `CACHE_FLUSH` is only valid when the topology includes a cache
  node. The retry loop must skip this stressor for non-cache topologies — same pattern as
  `QUOTA_IDENTITY_BUG`.
- **Hit rate is applied in `_dispatch`, not `_inject`**: the token enters the cache node's
  queue/slot normally (showing up in queue peaks), but upon completion the miss/hit decision
  determines whether it forwards downstream. This means the cache's own queue can still drop
  under extreme load, but the primary failure should be DB queue overflow — ensure the cache
  has large enough `max_concurrency` and `queue_limit` so it isn't the bottleneck.
- **Deterministic hash**: using `token.id % 1000 < hit_rate * 1000` gives perfect
  determinism. With IDs 0–999, exactly `floor(hit_rate * 1000)` tokens are hits. Verify the
  hash produces the right distribution in the partial-hit test.
- **`verifyAndAdjust` runs with baseline hit rate**: the pre-stressor stability check must
  use the original `hit_rate` value so the adjusted arrival rate assumes normal cache behaviour.
  The stressor then drops `hit_rate` to 0 in the stressed copy, which is not re-verified
  (intentionally — it's supposed to cause failure).
