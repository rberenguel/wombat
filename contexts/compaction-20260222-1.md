# Session Compaction Summary

## User Intent

- Expand the physics engine with new distributed systems failure modes
- Plan four new features (circuit breakers, caches, retry storms, network partitions) with detailed implementation specs
- Implement network partitions as the first of the four planned features
- Add a diagram help modal to explain node stats and edge semantics to players

## Contextual Work Summary

### Feature Plans (`plans/`)

Four implementation plans created, each covering simulator changes, generator changes, graph/UI changes, and test cases:
- `20260222-circuit-breakers.md` — CB trips on N failures in window; `CB_OPEN_DROP` event; compound stressor
- `20260222-cache-thundering-herd.md` — cache node subtype with hit_rate; `CACHE_FLUSH` stressor; cylinder rendering
- `20260222-retry-storms.md` — zero-backoff retry mode; upstream slot released immediately, downstream flooded
- `20260222-network-partitions.md` — partitioned SYNC edge; token black-holed; upstream waits full timeout

### Network Partition — Simulator (`js/simulator.js`)

- In `_dispatch`, SYNC branch: if `edge.partitioned`, skip `_inject` to target (token silently dropped)
- Ack still created and sync_wait added — upstream holds slot for full `timeout_ticks` before TIMEOUT_CASCADE
- Fixed DEADLINE_EXCEEDED semantics: only fires when `max_retries > 0 || deadline_ticks > 0` (i.e. a retry/deadline policy was active). With no policy, SYNC timeout just releases slot via TIMEOUT_CASCADE, letting queue pressure determine the terminal event.

### Network Partition — Generator (`js/generator.js`)

- `NETWORK_PARTITION` added to `STRESSOR_TYPES`; gated on at least one SYNC edge existing
- Stressor picks a SYNC edge, sets `partitioned: true` on the cloned edge (timeout unchanged — the generous baseline timeout is the weapon)
- `buildExplanation` branch: explains black-hole mechanic and names the timeout wait as the cause
- Null-guard added for forced-type when no SYNC edges available

### Network Partition — Graph (`js/graph.js`, `style.css`)

- New `arrow-partition` SVG marker; `--partition-color` CSS variable (light red, distinct from stress red)
- `color_class = 'partition'` takes priority over `is_stressed` in `_drawEdge`
- Edge label second line: `PARTITIONED` instead of `timeout:N`
- `.edge--partition` CSS: red dashed stroke (`stroke-dasharray: 8 4`)
- Legend entry added to `index.html`

### Test Fixes

- Generator test corrected: partition failure can be anywhere in upstream SYNC chain, not necessarily at direct caller — assert failure is NOT at partitioned target, not that it IS at source
- Simulator test corrected: with no retry policy, SYNC timeout must NOT fire DEADLINE_EXCEEDED — test now asserts `deadlines.length === 0`

### Diagram Help Modal

- `ph-question` icon codepoint `\e3e8` sourced from `fonts/phosphor/phosphor.css`
- `?` button in graph panel title (right-aligned via `margin-left: auto` on flex child)
- Modal outside `<main>`, inside `#app`; covers NODE STATS, EDGES, SYSTEM POLICY sections
- Show/hide via `.is-open` CSS class (not `hidden` attribute — UA stylesheet interaction was unreliable)
- Closes on: close button, click outside modal card, Escape key

## Files Touched

### Core Logic
- **js/simulator.js**: Partition guard in `_dispatch`; DEADLINE_EXCEEDED gated on retry/deadline policy
- **js/generator.js**: `NETWORK_PARTITION` stressor; null-guard; `buildExplanation` branch

### UI
- **js/graph.js**: `arrow-partition` marker; `color_class` priority; "PARTITIONED" edge label
- **js/main.js**: Help modal DOM refs and open/close event listeners
- **index.html**: `ph-question` codepoint; help button in graph panel; full modal HTML; legend entry
- **style.css**: `--partition-color`; `.edge--partition`; `.legend-partition`; `.edge-label--partition`; help button + modal CSS

### Plans
- **plans/20260222-circuit-breakers.md**: Full implementation plan
- **plans/20260222-cache-thundering-herd.md**: Full implementation plan
- **plans/20260222-retry-storms.md**: Full implementation plan
- **plans/20260222-network-partitions.md**: Full implementation plan

### Tests
- **tests/test_simulator.js**: 5 new network partition tests; DEADLINE_EXCEEDED no-policy test corrected
- **tests/test_generator.js**: 2 new partition tests; failure-node assertion corrected

## Known State

- All prior tests passing; network partition tests added
- Six stressor types: LATENCY_SPIKE, CONCURRENCY_CRUSH, ARRIVAL_SPIKE, TIMEOUT_TRAP, QUOTA_IDENTITY_BUG, NETWORK_PARTITION
- DEADLINE_EXCEEDED is now exclusively the TIMEOUT_TRAP answer (retry budget exhausted)
- NETWORK_PARTITION → QUEUE_DROP at upstream caller (or anywhere in SYNC chain above partition)
- Next planned features: circuit breakers, cache/thundering herd, retry storms (plans written, not implemented)
