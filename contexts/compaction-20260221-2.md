# Session Compaction Summary

## User Intent
- Polish the WoMbat game UI (edge label readability, policy clarity, stressed vs baseline display)
- Make DEADLINE_EXCEEDED a real reachable quiz answer via exponential backoff retries
- Implement token bucket rate limiting as a new failure mode (RATE_LIMIT_DROP)

## Contextual Work Summary

### Edge Label Fixes
- Labels deferred to after nodes in SVG DOM order so they always render on top
- Each label gets a background `<rect>` (dark fill, subtle border) for readability
- SYNC labels now two-line: `SYNC` / `timeout:N` using `<tspan>`; ASYNC remains single line
- `t/o:` abbreviation replaced with `timeout:`
- Label vertical offset increased to `-20` from midpoint to clear the arrow line

### System Policy Display
- Added dynamic `#system-policy` line in incident panel: shows retry count and policy
- TIMEOUT_TRAP scenarios display `retries: 2 (exp. backoff)`; all others `retries: none`
- DEADLINE_EXCEEDED button subtitle fixed: "SYNC timed out, no retries left"

### Graph Now Shows Stressed Values
- `graph.js` `render()` switched from `scenario.nodes/edges` to `scenario.stressed_nodes/stressed_edges`
- Players now see actual impacted values (spiked latency, crushed concurrency, tight timeout) in the graph

### Exponential Backoff Retries (TIMEOUT_TRAP)
- Simulator retry logic changed from linear reset to `timeout × 2^retry_count` per attempt
- TIMEOUT_TRAP stressor now runs with `max_retries: 2` — slot held for T + 2T + 4T ticks total
- Quiz answer for TIMEOUT_TRAP changed from `first_timeout_cascade` to `r.failure` (DEADLINE_EXCEEDED)
- `buildExplanation` for DEADLINE_EXCEEDED updated to describe the exponential backoff pattern
- `generator.js` exposes `max_retries` and `deadline_ticks` on the scenario object
- Retry test parameters fixed: `B.latency=30`, `A.queue=30` to prevent QUEUE_DROP preempting DEADLINE_EXCEEDED

### Token Bucket Rate Limiting
- **Simulator**: optional `token_bucket: {capacity, refill_rate}` per node; bucket refills each tick before injection; `_inject` checks bucket first — empty → fast-fail (SYNC ack resolved immediately) + `RATE_LIMIT_DROP` terminal event
- **Generator**: buckets assigned post-`verifyAndAdjust` to ~35% of non-entry nodes with 2–3× headroom over effective arrival rate; new `QUOTA_IDENTITY_BUG` stressor collapses one bucket to ~10% capacity / ~15% refill; `ARRIVAL_SPIKE` naturally exhausts buckets with no extra code; retry loop handles `null` from inapplicable stressors
- **Graph**: `NODE_H` 80→96, `NODE_GAP` 110→126; quota line rendered in purple at `y+70` (`quota: N  +R/t`); stress label moved to `y+84`
- **Quiz**: new "Rate Limited / quota bucket exhausted" button (`RATE_LIMIT_DROP`)
- **Tests**: 3 new token bucket tests — exhaustion, refill stability, SYNC fast-fail

## Files Touched

### Core Logic
- **js/simulator.js**: Bucket init in constructor, refill in `tick()`, bucket check in `_inject()`, `RATE_LIMIT_DROP` as terminal event, exponential backoff retry formula
- **js/generator.js**: `assignBuckets()` after `verifyAndAdjust`, `QUOTA_IDENTITY_BUG` stressor, deep-clone of `token_bucket` in `applyStressor`, `RATE_LIMIT_DROP` in `buildExplanation`, null-safe retry loop, `max_retries`/`deadline_ticks` in scenario return

### UI
- **js/graph.js**: DOM order fix (labels after nodes), background rects on labels, two-line SYNC labels, stressed values rendering, NODE_H/NODE_GAP increase, quota line in `_drawNode`
- **js/main.js**: `$policy` DOM ref, dynamic policy text, `RATE_LIMIT_DROP` in `labelForType`
- **index.html**: `#system-policy` element, Rate Limited quiz button, DEADLINE_EXCEEDED subtitle fix
- **style.css**: `.edge-label-bg`, `.node-quota` (purple), `.system-policy` (dim)

### Tests
- **tests/test_simulator.js**: Retry test params corrected, 3 new token bucket tests
- **tests/test_generator.js**: `RATE_LIMIT_DROP` added to valid answer types

## Known State
- All prior tests passing; new token bucket tests added
- Five stressor types: LATENCY_SPIKE, CONCURRENCY_CRUSH, ARRIVAL_SPIKE, TIMEOUT_TRAP, QUOTA_IDENTITY_BUG
- Four quiz failure types: QUEUE_DROP, TIMEOUT_CASCADE, DEADLINE_EXCEEDED, RATE_LIMIT_DROP
- Circuit breakers discussed but not yet implemented — next candidate feature
