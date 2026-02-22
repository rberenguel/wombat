# Session Compaction Summary

## User Intent

- Implement the last remaining plan: circuit breakers (`plans/20260222-circuit-breakers.md`)
- Add `CB_OPEN_DROP` as a new terminal failure type and `CIRCUIT_BREAKER_FLAP` as a new stressor
- Update README, bump version to 0.4.0, and clean up completed plan file

## Contextual Work Summary

### Circuit Breaker — Simulator Physics (`js/simulator.js`)

- `NodeState` extended with `cb_failure_ticks`, `cb_tripped`, `cb_cooldown`
- `_inject` now fast-fails when a node's CB is open: resolves upstream SYNC acks immediately, logs `CB_OPEN_DROP` (terminal, goes to `first_failure`)
- New `_record_cb_failure(node_id)` helper: sliding-window failure counter; trips CB when SYNC timeout count reaches threshold within `window_ticks`
- `tick()` gains two additions: CB cooldown loop (half-open reset at 0) runs before the per-node slot loop; `_record_cb_failure` called on every `TIMEOUT_CASCADE`

### Circuit Breaker — Generator (`js/generator.js`)

- New `assignCircuitBreakers(rng, nodes, edges)`: assigns `circuit_breaker` config to ~25% of non-entry SYNC-target nodes; called in `generateScenario` after `assignBuckets`
- `CIRCUIT_BREAKER_FLAP` stressor added to `STRESSOR_TYPES`: compound stressor — reduces threshold to 1 and shortens the incoming SYNC edge timeout below the target's latency; cooldown clamped to ≥80 ticks to outlast the 600-tick simulation window
- `applyStressor`: clones `circuit_breaker` in the deep-clone step; adds `cb_nodes` filter and availability/null-guard logic
- `buildExplanation`: new `CB_OPEN_DROP` branch referencing the cooldown period

### Circuit Breaker — UI

- `js/graph.js`: `⚡ CB` amber badge rendered in top-right corner of any node with `circuit_breaker`
- `style.css`: `.node-cb-badge` class (amber, 8px, bold)
- `index.html`: "Circuit Open / breaker tripped, cascade rejection" quiz button (`data-type="CB_OPEN_DROP"`)
- `js/main.js`: `CB_OPEN_DROP` → `"Circuit Open"` in `labelForType`

### Tests

- `tests/test_simulator.js`: 4 new tests in "Circuit breaker" describe block — CB trips after threshold, CB fast-fails SYNC acks (fixed: `sim.arrival_rate = 0` after tick 1 to prevent fresh arrivals polluting the assertion), CB resets after cooldown, CB does not trip on ASYNC traffic
- `tests/test_generator.js`: 3 new tests in "CIRCUIT_BREAKER_FLAP stressor" describe — CB_OPEN_DROP answer, baseline stability with CB nodes, CB assignment restricted to SYNC targets; `valid_types` list updated to include `CB_OPEN_DROP`

### Bug Fix During Testing

- CB fast-fail test initially failed: with `arrival_rate=1`, tick 2 injected a new token that also dispatched to B (CB still open), creating a new `sync_wait` with `sw.done=false`. Fix: set `sim.arrival_rate = 0` between tick 1 and tick 2.

### Docs & Version

- `README.md`: stressor table extended with Circuit Breaker Flap row; failure modes table extended with Circuit Open; simulation and generator description paragraphs updated; test coverage description updated
- `manifest.json`: bumped 0.3.0 → 0.4.0
- `plans/20260222-circuit-breakers.md`: deleted (fully implemented)

## Files Touched

### Core Logic

- **js/simulator.js**: CB state in NodeState, `_inject` fast-fail, `_record_cb_failure`, CB cooldown in `tick()`, `_record_cb_failure` call on TIMEOUT_CASCADE
- **js/generator.js**: `assignCircuitBreakers`, `CIRCUIT_BREAKER_FLAP` stressor, `buildExplanation` CB branch, `applyStressor` CB cloning + availability filter

### UI

- **js/graph.js**: `⚡ CB` badge on CB nodes
- **js/main.js**: `CB_OPEN_DROP` in `labelForType`
- **index.html**: Circuit Open quiz button
- **style.css**: `.node-cb-badge` style

### Tests

- **tests/test_simulator.js**: 4 new CB physics tests
- **tests/test_generator.js**: 3 new CB generator invariant tests + `CB_OPEN_DROP` in `valid_types`

### Config & Docs

- **manifest.json**: version 0.3.0 → 0.4.0
- **README.md**: stressor table, failure modes table, simulation/generator/test descriptions updated
- **contexts/**: this file
- **plans/**: circuit-breakers deleted; plans/ now empty
