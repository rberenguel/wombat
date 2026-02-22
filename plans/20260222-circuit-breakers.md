# Plan: Circuit Breakers

## Puzzle concept

A node has a circuit breaker configured with a failure threshold and observation window.
When the breaker trips, it immediately fast-fails every subsequent incoming token (resolving
SYNC acks instantly) rather than queuing or processing them. The puzzle question is whether
the upstream benefits from the fast-fail (its slots free up faster) or whether the now-absent
downstream still causes collapse elsewhere.

The most interesting stressor is a **misconfigured breaker** that trips too eagerly under
normal-ish elevated load, making a node functionally disappear mid-scenario. The player must
decide: does the CB save the system, or does it trigger a new failure by severing a critical path?

---

## New failure event type

`CB_OPEN_DROP` — logged (terminal) the first time a token is rejected because the breaker
on that node is tripped. This is the quiz answer for CB-related scenarios. New quiz button:
**"Circuit Open / cascade rejection"**.

---

## Simulator changes (`js/simulator.js`)

### NodeState additions

```js
class NodeState {
  constructor() {
    this.slots  = [];
    this.queue  = [];
    // Circuit breaker state
    this.cb_failure_ticks = []; // ring of tick numbers when a failure was recorded
    this.cb_tripped       = false;
    this.cb_cooldown      = 0;  // ticks remaining in open state before half-open attempt
  }
}
```

### `_inject` — fast-fail when open

After the token-bucket check and before the queue/slot logic:

```js
if (def.circuit_breaker && ns.cb_tripped) {
  for (const ack of token.release_acks) ack.done = true; // release upstream SYNC slot
  this._log('CB_OPEN_DROP', node_id, token, `${def.name} circuit open`);
  return;
}
```

### `_record_cb_failure(node_id)` — new helper

Called whenever a TIMEOUT_CASCADE fires on a SYNC wait *targeting* this node (i.e. the
node that didn't respond in time). Maintains a sliding window:

```js
_record_cb_failure(node_id) {
  const def = this.nodes[node_id];
  if (!def.circuit_breaker || this.state[node_id].cb_tripped) return;
  const cb  = def.circuit_breaker;
  const ns  = this.state[node_id];
  // Prune failures outside the observation window.
  ns.cb_failure_ticks = ns.cb_failure_ticks.filter(
    t => this.tick_count - t <= cb.window_ticks
  );
  ns.cb_failure_ticks.push(this.tick_count);
  if (ns.cb_failure_ticks.length >= cb.threshold) {
    ns.cb_tripped  = true;
    ns.cb_cooldown = cb.cooldown_ticks;
  }
}
```

### `tick()` additions

**Before** the per-node slot loop — advance CB cooldowns and attempt half-open reset:

```js
for (const [node_id, ns] of Object.entries(this.state)) {
  if (ns.cb_tripped && ns.cb_cooldown > 0) {
    ns.cb_cooldown--;
    if (ns.cb_cooldown === 0) {
      // Half-open: reset and let one request through.
      ns.cb_tripped = false;
      ns.cb_failure_ticks = [];
    }
  }
}
```

**In the TIMEOUT_CASCADE branch** (existing `sw.timeout_remaining <= 0` block), after
logging the cascade, call:

```js
this._record_cb_failure(sw.edge.target_id);
```

### No changes needed to `_dispatch` or `_release_slot`.

---

## Generator changes (`js/generator.js`)

### New node property

```js
node.circuit_breaker = {
  threshold:     N,   // number of failures in window to trip
  window_ticks:  W,   // sliding window size
  cooldown_ticks: C,  // how long the breaker stays open before half-open attempt
};
```

### `assignCircuitBreakers()` — called after `assignBuckets()`

Assign to ~25 % of non-entry nodes that are SYNC targets (a CB on an ASYNC-only target has
no hold-time effect to demonstrate):

```js
function assignCircuitBreakers(rng, nodes, edges) {
  const sync_targets = new Set(
    edges.filter(e => e.mode === 'SYNC').map(e => e.target_id)
  );
  for (const node of nodes.slice(1)) {
    if (!sync_targets.has(node.id)) continue;
    if (rng() < 0.25) {
      node.circuit_breaker = {
        threshold:     randInt(rng, 3, 6),
        window_ticks:  randInt(rng, 20, 40),
        cooldown_ticks: randInt(rng, 30, 60),
      };
    }
  }
}
```

### New stressor: `CIRCUIT_BREAKER_FLAP`

Requires at least one node with a `circuit_breaker`. Reduces the threshold to 1–2 so the
breaker trips almost immediately under any TIMEOUT_CASCADE:

```js
} else if (type === 'CIRCUIT_BREAKER_FLAP') {
  const cb_nodes = nodes.filter(n => n.circuit_breaker);
  const target   = pick(rng, cb_nodes);
  const old_thresh = target.circuit_breaker.threshold;
  const new_thresh = 1;
  nodes.find(n => n.id === target.id).circuit_breaker = {
    ...target.circuit_breaker,
    threshold: new_thresh,
  };
  description = `${target.name}'s circuit breaker threshold was misconfigured to ${new_thresh} ` +
    `(was ${old_thresh}). A single downstream timeout now opens the breaker immediately, ` +
    `rejecting all subsequent traffic for ${target.circuit_breaker.cooldown_ticks} ticks.`;
  mutation = { type, node_id: target.id, property: 'circuit_breaker.threshold',
               old_value: old_thresh, new_value: new_thresh };
}
```

Add `'CIRCUIT_BREAKER_FLAP'` to `STRESSOR_TYPES`. Gate it on `cb_nodes.length > 0`.

### Stressor runner

For `CIRCUIT_BREAKER_FLAP`, the simulator needs to apply even a small amount of load to
trigger the cascade. The stressor itself reduces the threshold, and the same arrival rate
that was stable before will generate enough SYNC timeouts (from the paired LATENCY_SPIKE-like
effect of the misconfigured CB eating requests) to trip it.

Consider pairing: when this stressor is chosen, also spike the targeted node's latency by 3–4×
(just enough to cause a few timeouts that trip the threshold-1 breaker, which then takes the
node fully offline). Document this as a **compound stressor** — the latency anomaly triggers
the over-sensitive breaker.

### Quiz answer

```js
// CIRCUIT_BREAKER_FLAP
const answer_type = 'CB_OPEN_DROP';
const answer_node = target.id; // the node whose breaker tripped
```

### `buildExplanation` addition

```js
if (failure.type === 'CB_OPEN_DROP') {
  return `${failed_node}'s circuit breaker tripped after ${stressor.mutation.new_value} failure(s) ` +
    `within the observation window. For the next ${nodes_map[failure.node_id].circuit_breaker.cooldown_ticks} ticks ` +
    `all incoming requests were fast-failed, severing the downstream path and causing ` +
    `upstream queues to fill with error responses.`;
}
```

---

## Graph / UI changes (`js/graph.js`, `index.html`, `style.css`)

### Node rendering

- Nodes with `circuit_breaker` get a small **⚡ CB** badge in the bottom-right corner
  (amber colour, similar to the quota line).
- When `cb_tripped` is part of the reveal state (post-reveal), re-render the node with
  an open-lock or red ring visual. (Reveal state is not live during the simulation — we
  only show it in the post-reveal graph redraw.)

### New quiz button in `index.html`

```html
<button class="guess-btn" data-type="CB_OPEN_DROP">
  Circuit Open
  <span class="guess-sub">breaker tripped, cascade rejection</span>
</button>
```

### `labelForType` in `main.js`

```js
case 'CB_OPEN_DROP': return 'Circuit Open';
```

---

## Test cases (`tests/test_simulator.js`, `tests/test_generator.js`)

### Simulator tests

1. **CB trips after threshold**: configure a node with `circuit_breaker: {threshold:2, window:20, cooldown:50}`,
   inject enough SYNC timeouts to cross threshold, assert next inject returns `CB_OPEN_DROP`.
2. **CB fast-fails SYNC acks**: when CB is open, upstream SYNC slot is released immediately
   (ack.done=true), confirming no slot leakage.
3. **CB cooldown resets**: after `cooldown_ticks`, the breaker is half-open and accepts one
   token again without `CB_OPEN_DROP`.
4. **CB doesn't trip on ASYNC timeouts** (no upstream SYNC hold to record against).

### Generator tests

5. **CIRCUIT_BREAKER_FLAP stressor produces CB_OPEN_DROP answer** across 3 seeds.
6. **Baseline with CB nodes is stable** — CB should not trip under the pre-stressor arrival rate.
7. **CB nodes are only assigned to SYNC targets** — assert no CB on ASYNC-only nodes.

---

## Key invariants / gotchas

- **CB only trips on SYNC timeout cascades** reaching its target. QUEUE_DROPs and
  RATE_LIMIT_DROPs at other nodes should not influence the CB counter — only timeouts
  experienced by SYNC waiters *pointing at* this node.
- **Cooldown must be long enough** that the scenario ends before the breaker resets — otherwise
  the system might recover mid-run and no terminal event fires. Set `cooldown_ticks ≥ 80` in
  the stressor to guarantee the scenario window (600 ticks) sees the full open period.
- **Don't assign CB to entry node** — there's no upstream SYNC wait that points at the entry.
- **Stressor retry loop**: `CIRCUIT_BREAKER_FLAP` with no CB nodes returns `null` → retry loop
  skips it, consistent with `QUOTA_IDENTITY_BUG` pattern.
- **The compound stressor (CB_FLAP + latency spike)** means the mutation object must record
  both changes; `buildExplanation` and the incident description must describe both causes.
