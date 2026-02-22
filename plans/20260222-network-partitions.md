# Plan: Network Partitions (Split Brain)

## Puzzle concept

A **network partition** severs a specific edge in the graph. Unlike `TIMEOUT_TRAP` (where
the downstream is alive but slow), a partition is a silent black hole: tokens sent across
the edge are never delivered and never acknowledged. The upstream SYNC caller can't distinguish
this from an infinitely slow downstream — it just waits the full `timeout_ticks` before
seeing a TIMEOUT_CASCADE.

The pedagogical distinction is crucial:
- **Latency spike** → downstream is slow but still responds eventually.
- **Timeout trap** → downstream responds, but timeout fires before it arrives.
- **Network partition** → downstream never responds; upstream always waits the *full* timeout.

Because baseline timeouts are generous (6× downstream latency + jitter), a partition ties up
upstream SYNC slots for far longer than a latency spike would. With `max_concurrency` slots
all occupied waiting for a black hole, the upstream queue fills and drops — even at a moderate
arrival rate.

**The deceptive element**: the partition node itself shows no queue activity (it receives
nothing), so the player might guess the wrong node. The failure is at the *caller* node
(upstream of the partitioned edge), not at the partitioned target.

---

## New edge property

```js
{
  source_id: 'n1',
  target_id: 'n2',
  mode: 'SYNC',
  timeout_ticks: 45,
  partitioned: true,   // NEW — tokens are black-holed on this edge
}
```

`partitioned: false` (or absent) = normal behaviour.

---

## Simulator changes (`js/simulator.js`)

### `_dispatch` modification

In the SYNC branch of `_dispatch`, before calling `_inject`:

```js
if (edge.mode === 'SYNC') {
  const ack = new SyncAck();
  t.release_acks.push(ack);

  if (!edge.partitioned) {
    this._inject(edge.target_id, t);
  }
  // If partitioned: token is silently dropped. Ack never resolves.
  // The upstream will wait the full timeout_ticks before TIMEOUT_CASCADE fires.

  slot.sync_waits.push({
    ack,
    timeout_remaining: edge.timeout_ticks,
    edge,
    done: false,
  });
  has_sync = true;
}
```

No other changes. The existing TIMEOUT_CASCADE → DEADLINE_EXCEEDED path handles the rest.
With `max_retries: 0` (default for this stressor), every SYNC call immediately cascades to
`TIMEOUT_CASCADE` after `timeout_ticks` ticks, then the upstream slot is released.

The upstream's slot occupancy per token is exactly `local_latency_ticks + timeout_ticks`.
With a generous baseline timeout (e.g. 45 ticks), that's 45 ticks per slot — far higher
than the stable equilibrium assumed by `safeArrivalRate`.

### No new event types needed.

The failure sequence is:
1. Tokens sent over partitioned edge → black-holed.
2. Upstream SYNC waits → `TIMEOUT_CASCADE` after `timeout_ticks`.
3. No retries (stressor uses `max_retries: 0`).
4. Upstream slot freed, but new arrivals fill it immediately.
5. Upstream queue fills → `QUEUE_DROP` at upstream caller.

Quiz answer: `QUEUE_DROP` at the node *upstream* of the partitioned edge (the caller, not
the black-holed target).

---

## Generator changes (`js/generator.js`)

### New stressor: `NETWORK_PARTITION`

Pick a SYNC edge. Set `partitioned: true`. Do **not** change `timeout_ticks` (the long
baseline timeout is the mechanism — that's what makes a partition worse than a latency spike).

```js
} else if (type === 'NETWORK_PARTITION') {
  const sync_edges = edges.filter(e => e.mode === 'SYNC');
  if (!sync_edges.length) return null; // can't partition an ASYNC-only topology

  const edge = pick(rng, sync_edges);
  const src_name = nodes.find(n => n.id === edge.source_id).name;
  const tgt_name = nodes.find(n => n.id === edge.target_id).name;

  edges.find(e => e.source_id === edge.source_id && e.target_id === edge.target_id)
       .partitioned = true;

  description =
    `Network partition detected between ${src_name} and ${tgt_name}. ` +
    `Packets are silently dropped — no TCP RST, no error response. ` +
    `${src_name} cannot distinguish this from an infinitely slow downstream ` +
    `and waits the full ${edge.timeout_ticks}-tick timeout on every SYNC call.`;
  mutation = {
    type,
    edge: { source_id: edge.source_id, target_id: edge.target_id },
    property: 'partitioned',
    old_value: false,
    new_value: true,
  };
}
```

Add `'NETWORK_PARTITION'` to `STRESSOR_TYPES`. Gate it on `sync_edges.length > 0`.

### Why this reliably causes failure

Under a partition, the upstream caller's effective slot time becomes:
```
local_latency_ticks + timeout_ticks
```
rather than:
```
local_latency_ticks + downstream_local_latency_ticks
```

The baseline `timeout_ticks` is `downstream_latency * 6 + jitter`. So the effective slot
time balloons by ~6×. The `safeArrivalRate` was computed assuming the normal downstream
latency, so the stressed system is grossly overloaded — failure is guaranteed.

This means `NETWORK_PARTITION` almost never needs the stressor retry loop. If it does fail
to produce a `quiz_event`, it will be caught by the retry loop like any other stressor.

### Stressor runner

`max_retries: 0`, `deadline_ticks: 0` — same as LATENCY_SPIKE and CONCURRENCY_CRUSH.
No special retry or deadline logic.

### Quiz answer

`QUEUE_DROP` at the upstream caller node (`edge.source_id`). No new terminal event type.

### `buildExplanation` addition

```js
if (stressor.type === 'NETWORK_PARTITION') {
  const src = nodes_map[stressor.mutation.edge.source_id]?.name ?? stressor.mutation.edge.source_id;
  const tgt = nodes_map[stressor.mutation.edge.target_id]?.name ?? stressor.mutation.edge.target_id;
  return (
    `${src} was making SYNC calls to ${tgt} across a partitioned network link. ` +
    `Every packet was silently dropped — no error, no RST. ` +
    `${src} waited the full ${/* edge timeout */ 'timeout_ticks'} ticks on each call ` +
    `before seeing a timeout, holding its concurrency slot for the entire duration. ` +
    `With all slots occupied by waiting calls that could never complete, ` +
    `${failed_node}'s queue filled and dropped incoming requests.`
  );
}
```

Note: `buildExplanation` needs access to the stressor's edge data to retrieve `timeout_ticks`.
The `stressor.mutation` object already stores `edge: { source_id, target_id }` — retrieve
the actual edge from `stressed_edges` to get the timeout value.

---

## Graph / UI changes (`js/graph.js`, `style.css`)

### Edge rendering — partition visual

A partitioned edge should visually signal the black hole. Options:
- **Dashed/broken stroke**: replace the solid arrow with a dashed line (CSS `stroke-dasharray`).
- **Red tint with an X or ∅ marker** at the midpoint, replacing the normal arrowhead.
- **Label**: instead of `SYNC / timeout:N`, show `SYNC / ✕ PARTITIONED` in red.

Recommended: dashed red stroke + `PARTITIONED` label (replaces the `timeout:N` line).
Consistent with the existing stressed-edge highlighting (which uses a different hue but
similar approach).

Implementation in `_drawEdge`:

```js
if (edge.partitioned) {
  line.setAttribute('stroke', '#e55');
  line.setAttribute('stroke-dasharray', '6,4');
  // Label: replace timeout line with PARTITIONED
  label_lines = ['SYNC', 'PARTITIONED'];
  label_color = '#e55';
}
```

The stressed graph (which uses `stressed_edges`) will show the partitioned edge with the
broken-line visual. The baseline graph (pre-reveal, showing `scenario.stressed_edges` already)
will also show it — this is fine and consistent with how latency spikes and concurrency
crushes are already shown on the stressed graph.

### Post-reveal: highlight the upstream caller

After reveal, colour the upstream caller node (edge.source_id) red (wrong guess) or green
(correct guess), as with other failure types. The target node (black-holed) is rendered
normally — it has no failure, which may surprise the player and reinforce the lesson.

### No new quiz button required.

`QUEUE_DROP` already exists. The failure renders at the upstream caller, not at the target —
which is itself the puzzle challenge.

---

## Test cases

### Simulator tests

1. **Partition prevents downstream injection**: set up a SYNC edge with `partitioned: true`.
   After dispatching from the source node, assert that the target node's `state` shows zero
   slots and zero queue (nothing was injected).
2. **Upstream waits full timeout then releases**: with `timeout_ticks: 10` and `partitioned: true`,
   assert that the upstream slot is held for exactly 10 ticks before being freed
   (TIMEOUT_CASCADE fires at tick 10, slot released on same tick).
3. **Queue drop at upstream, not target**: configure [entry → caller → target] with the
   caller → target edge partitioned. Run until failure. Assert `QUEUE_DROP` is at `caller.id`,
   not `target.id` or `entry.id`.
4. **No retries on partition**: with `max_retries: 0`, assert only one TIMEOUT_CASCADE per
   token (no exponential backoff attempts). The slot is released after the first timeout.
5. **ASYNC partitioned edge**: edge with `mode: 'ASYNC'` and `partitioned: true`. Tokens are
   injected ASYNC (fire and forget) — should the partition still apply? Decision: yes, they're
   black-holed and never delivered. The upstream already released its slot (ASYNC), so no
   slot starvation occurs. The system may remain stable (ASYNC callers don't notice). This
   is intentional — `NETWORK_PARTITION` is most impactful on SYNC edges. The generator
   should only pick SYNC edges.
6. **Contrast test with LATENCY_SPIKE**: identical topology, LATENCY_SPIKE 6× on same node
   vs NETWORK_PARTITION on same edge. Both cause upstream QUEUE_DROP, but partition fails
   faster (full timeout every time vs slow processing that may occasionally complete).

### Generator tests

7. **NETWORK_PARTITION stressor causes QUEUE_DROP at upstream caller** across 3 seeds.
8. **Partitioned edge is SYNC** — assert `mutation.edge` is a SYNC edge in stressed_edges.
9. **Baseline graph is stable without partition** — same topology, `max_retries: 0`,
   no partition → no failure within 600 ticks.
10. **Stressor gates on SYNC edge availability** — topology with all-ASYNC edges returns
    `null` from `applyStressor`, retry loop handles it gracefully.

---

## Key invariants / gotchas

- **The quiz answer is the *caller*, not the *target*** — this is the counterintuitive point
  of the puzzle. Make sure `buildExplanation` and the answer node correctly identify
  `edge.source_id` as the failing node, not `edge.target_id`. The existing simulator naturally
  produces `QUEUE_DROP` at the upstream caller (since that's where the slot is held and the
  queue fills), so this should be correct without special handling.
- **Don't change timeout_ticks** — the whole point is that the existing generous timeout
  becomes the weapon. Shrinking the timeout would make this behave like TIMEOUT_TRAP.
  The stressor mutation only sets `partitioned: true`.
- **Graph shows baseline vs stressed**: since both baseline and stressed graphs already show
  `stressed_edges` (per the session-2 compaction note), the broken-line will appear from the
  start of the quiz. This is correct — the player can see the partition in the graph and
  reason about it before guessing.
- **ASYNC-only topologies**: if a randomly chosen topology has no SYNC edges, `NETWORK_PARTITION`
  returns `null`. The retry loop will pick another stressor. This should be rare given the
  generator's 40–65% SYNC probability, but must be handled.
- **Stressor interaction with token buckets**: if the target node has a token bucket, it
  never fires (no tokens reach it). The bucket state is irrelevant. No special handling needed.
- **`buildExplanation` edge lookup**: the function signature currently only receives
  `failure, events, nodes_map, stressor`. To get `timeout_ticks`, either store it in
  `stressor.mutation` at generation time (simplest), or look it up from `stressed_edges`
  (requires passing edges to `buildExplanation`). Recommend storing it in `mutation`:
  `mutation.timeout_ticks = edge.timeout_ticks`.
