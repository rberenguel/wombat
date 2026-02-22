# Plan: Retry Storms

## Puzzle concept

A misconfigured client has **zero-backoff retries**: every time a SYNC call times out, it
immediately re-injects a fresh token to the same downstream node — without waiting, and
without holding the upstream slot. On the surface this looks better than exponential backoff
(the upstream slot is released right away), but the downstream is hit with a multiplicative
flood: each concurrent upstream caller generates N immediate retries, turning M callers × N
retries into an M × N request storm that overwhelms the downstream queue almost instantly.

The player must reason about *amplification*, not just latency. The arrival rate at the
entry node is unchanged; it's the retry fan-out that creates the spike.

**Contrast with existing mechanics:**
- `TIMEOUT_TRAP` (exp. backoff): slot is held during retries → upstream starvation.
- `AGGRESSIVE_RETRIES` (zero backoff): slot released immediately → downstream flooding.

Both result in failure, but at opposite ends of the call chain.

---

## New failure event type

No new terminal type is needed. The failure is `QUEUE_DROP` at the downstream node —
the retry storm fills its queue. The `stressor.type === 'AGGRESSIVE_RETRIES'` in
`buildExplanation` is sufficient to give the right narrative.

---

## Simulator changes (`js/simulator.js`)

### New scenario-level flag

`cfg.retry_mode: 'immediate' | 'exponential' | 'none'` (default `'none'`).

`'exponential'` maps to the current `TIMEOUT_TRAP` behaviour. `'immediate'` is new.

Alternatively, expose this per-edge (`edge.retry_mode`) so different edges can have
different policies. Per-edge is more expressive but more complex. **Recommend per-scenario
flag** for v1 to keep the generator simple; a single stressor applies immediate retries
globally (one misconfigured client library poisons all outgoing SYNC calls from a node).

### Constructor

```js
this.retry_mode = cfg.retry_mode ?? 'none';
```

Existing `this.max_retries` is reused (number of retry attempts allowed per token).

### `tick()` — TIMEOUT_CASCADE branch

Current code (exponential backoff path):
```js
slot.token.retry_count++;
sw.timeout_remaining = sw.edge.timeout_ticks * Math.pow(2, slot.token.retry_count);
```

New branching:

```js
if (slot.token.retry_count < slot.token.max_retries && slot.token.deadline_remaining > 0) {
  slot.token.retry_count++;

  if (this.retry_mode === 'immediate') {
    // Zero-backoff: release the upstream slot immediately, but fire a new token
    // at the downstream right now. This floods the downstream without holding
    // the upstream concurrency slot.
    const retry_token = new Token(
      `${slot.token.id}:r${slot.token.retry_count}`,
      slot.token.deadline_remaining,
      slot.token.max_retries - slot.token.retry_count,
    );
    // The retry is fire-and-forget (ASYNC-style) — upstream doesn't wait for it.
    // This models the client that doesn't wait for a response before retrying.
    this._inject(sw.edge.target_id, retry_token);
    sw.done = true; // release the upstream SYNC wait
  } else {
    // Exponential backoff (existing behaviour).
    sw.timeout_remaining = sw.edge.timeout_ticks * Math.pow(2, slot.token.retry_count);
  }
} else {
  this._log('DEADLINE_EXCEEDED', ...);
  sw.done = true;
}
```

**Key design choice**: the retry token is injected directly into the downstream (not via
`_dispatch` on the upstream slot), and the upstream's `sw.done = true` frees the SYNC wait.
The upstream slot is released (via the `slot.sync_waits.every(sw => sw.done)` check) on the
same tick. This models a client that gives up on the pending call and immediately fires a new
one, without blocking on the result.

**Amplification math**: with `max_retries = 3` and `arrival_rate = 5`, a downstream node
that is too slow will receive:
- Tick T: 5 original tokens
- Tick T+timeout: 5 more (first retry of each)
- Tick T+timeout: 5 more (second retry of each) — all in the same tick if timeout is short
- Result: 15 tokens injected in a small window, vs the queue expecting 5/tick

With 3 retries and timeout = 2 ticks, the downstream sees a 4× burst. With timeout = 1 tick,
all retries land on consecutive ticks, effectively tripling the instantaneous arrival rate.

---

## Generator changes (`js/generator.js`)

### New stressor: `AGGRESSIVE_RETRIES`

Pick a SYNC edge. Set its `timeout_ticks` to a value guaranteed to fire frequently (similar
to `TIMEOUT_TRAP` — below the target's processing latency). Set `max_retries: 3` and
`retry_mode: 'immediate'`.

```js
} else if (type === 'AGGRESSIVE_RETRIES') {
  const sync_edges = edges.filter(e => e.mode === 'SYNC');
  const edge       = sync_edges.length ? pick(rng, sync_edges) : edges[0];
  const target_node = nodes.find(n => n.id === edge.target_id);
  const old_v  = edge.timeout_ticks;
  const new_v  = Math.max(1, Math.floor(target_node.local_latency_ticks * 0.4));
  edges.find(e => e.source_id === edge.source_id && e.target_id === edge.target_id)
       .timeout_ticks = new_v;
  const src_name = nodes.find(n => n.id === edge.source_id).name;
  description =
    `${src_name} is misconfigured with zero-backoff retries and a tight timeout of ${new_v} ticks ` +
    `(downstream latency is ${target_node.local_latency_ticks} ticks). Every timed-out call ` +
    `immediately spawns a fresh retry without waiting, multiplying load on ${target_node.name}.`;
  mutation = { type, edge, property: 'timeout_ticks',
               old_value: old_v, new_value: new_v, retry_mode: 'immediate', max_retries: 3 };
}
```

### Stressor runner update

When `stressor.type === 'AGGRESSIVE_RETRIES'`, pass `retry_mode: 'immediate'` and
`max_retries: 3` to the Simulator constructor:

```js
const retry_mode   = applied.stressor.type === 'AGGRESSIVE_RETRIES' ? 'immediate' : 'none';
const max_retries  = ['TIMEOUT_TRAP', 'AGGRESSIVE_RETRIES'].includes(applied.stressor.type)
                     ? (applied.stressor.type === 'TIMEOUT_TRAP' ? 2 : 3)
                     : 0;
```

Expose `retry_mode` on the returned scenario object so `main.js` can render the policy line:
`retries: 3 (zero backoff)`.

### Quiz answer

The terminal event is `QUEUE_DROP` at the downstream node (the one being retried against).
No special answer type is needed. The `buildExplanation` branch for `AGGRESSIVE_RETRIES`
describes the amplification pattern.

### `buildExplanation` addition

```js
if (stressor.type === 'AGGRESSIVE_RETRIES') {
  const mult = stressor.mutation.max_retries + 1;
  return `Each of the ${failed_node}'s callers timed out and immediately retried without waiting. ` +
    `With ${stressor.mutation.max_retries} retries per call and no backoff, each original request ` +
    `generated up to ${mult}× the downstream traffic. This ${mult}× amplification overwhelmed ` +
    `${failed_node}'s queue within ${failure.tick} ticks despite the entry arrival rate being unchanged.`;
}
```

---

## UI changes

### System policy line (`js/main.js`)

```js
if (scenario.retry_mode === 'immediate') {
  $policy.textContent = `retries: ${scenario.max_retries} (zero backoff — storm mode)`;
}
```

### Incident panel framing

The description (from `applyStressor`) already mentions zero-backoff retries. No extra UI
changes needed. The quiz answer is `QUEUE_DROP`, which exists.

### No new quiz button required.

---

## Test cases

### Simulator tests

1. **Retry storm floods downstream**: configure a SYNC edge with `timeout_ticks: 1` (shorter
   than downstream latency), `retry_mode: 'immediate'`, `max_retries: 3`. Run 10 ticks.
   Assert `QUEUE_DROP` at downstream, not at upstream.
2. **Upstream slot is released on immediate retry**: after a timeout with immediate retry,
   assert the upstream node's slots drop (slot freed), confirming no slot leakage.
3. **Retry count is respected**: with `max_retries: 2`, assert no token generates more than
   3 total attempts (1 original + 2 retries). Assert `DEADLINE_EXCEEDED` fires after budget
   exhausted (if no queue drop happens first).
4. **Zero-backoff vs exponential produces different failure node**: with identical topology and
   stressor edge, `retry_mode: 'exponential'` should cause upstream starvation (`QUEUE_DROP`
   at upstream), while `retry_mode: 'immediate'` should cause downstream flooding
   (`QUEUE_DROP` at downstream). This is the core physics contrast test.
5. **ASYNC edges are unaffected**: immediate retry only applies to SYNC waits; ASYNC
   dispatches have no retry mechanism (tokens are already fire-and-forget).

### Generator tests

6. **AGGRESSIVE_RETRIES stressor causes QUEUE_DROP at downstream** (not entry, not upstream)
   across 3 seeds.
7. **Retry mode field is set correctly on scenario object** — `scenario.retry_mode === 'immediate'`.
8. **Baseline is stable without retries** — same topology + arrival rate with `retry_mode: 'none'`
   should not fail within 600 ticks.

---

## Key invariants / gotchas

- **Retry tokens are fire-and-forget from the upstream's perspective**: the upstream releases
  its SYNC wait and picks up new work. The downstream receives an unbounded burst of retry
  tokens that pile into its queue. This is intentional — it models the case where the client
  library retries without tracking outstanding requests.
- **Retry tokens inherit remaining deadline**: if a deadline is set (it isn't for this stressor
  by default), retry tokens inherit `deadline_remaining` from the parent token. This prevents
  infinite retry storms when deadlines are active.
- **Max retries prevents infinite loops**: even with `retry_mode: 'immediate'`, each token
  family is limited to `max_retries` additional attempts. The terminal condition is either
  `QUEUE_DROP` (downstream fills up, which is the expected failure) or `DEADLINE_EXCEEDED`
  (budget exhausted, which acts as a backstop).
- **Don't confuse with ARRIVAL_SPIKE**: the entry arrival rate is *unchanged*. The stressor
  amplification is internal to the system. The incident description must make this explicit.
- **Stressor retry loop compatibility**: `runStressor` must pass `retry_mode` to the Simulator.
  The existing `runStressor` closure needs to derive `retry_mode` from `applied.stressor.type`.
