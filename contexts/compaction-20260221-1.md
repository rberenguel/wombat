# Session Compaction Summary

## User Intent
- Build a browser-based SRE training game ("WoMbat — Wheel of Misfortune") from scratch
- Game procedurally generates distributed system architectures, applies a stressor, and asks the user to predict the failure point before revealing the simulation result
- No backend, no build step — vanilla JS + HTML + CSS PWA

## Contextual Work Summary

### Core Simulation Engine (`js/simulator.js`)
- Discrete-event tick loop with `Token`, `Slot`, `NodeState`, `SyncAck` classes
- **SYNC edges** hold the upstream concurrency slot until downstream completes (via `SyncAck` ack-chain); **ASYNC edges** release immediately
- Parallel SYNC fan-out supported: slot held until all branches resolve
- Three failure types tracked: `QUEUE_DROP` (terminal), `DEADLINE_EXCEEDED` (terminal), `TIMEOUT_CASCADE` (non-terminal — stored in `first_timeout_cascade` separately so simulation continues through retries)
- Queue tokens also have deadlines decremented each tick (added mid-session after test failures)

### Scenario Generator (`js/generator.js`)
- Seeded RNG (`mulberry32`) for reproducibility
- Five DAG topology templates (linear 3/4-node, diamond, 5-node fan-out/fan-in)
- Four stressor types: `LATENCY_SPIKE`, `CONCURRENCY_CRUSH` (÷3, not ÷2), `ARRIVAL_SPIKE`, `TIMEOUT_TRAP`
- **Stability analysis** uses `effectiveSlotTime` (walks SYNC chains recursively) + `computeLoadFactors` (topological BFS for fan-in multiplier) to compute safe arrival rate
- **Verify-and-adjust loop**: runs baseline simulation after formula, reduces rate or boosts concurrencies if still unstable
- **Stressor retry loop**: if randomly chosen stressor doesn't cause failure within 600 ticks, cycles through remaining types — eliminates "held stable" quiz dead-ends
- `TIMEOUT_TRAP` quiz answer uses `first_timeout_cascade` (upstream caller node) rather than eventual queue drop

### Graph Renderer (`js/graph.js`)
- Pure SVG, no library — layered DAG layout with vertical centering per layer
- Node click → selection state; post-reveal highlights correct (green) and wrong (red) nodes
- Stressed nodes/edges highlighted distinctly

### Game UI (`js/main.js`, `index.html`, `style.css`)
- Three-panel layout: Incident → Architecture → Diagnosis → Result
- **Seed encoding**: 32-bit integer ↔ 7 lowercase letters (base-26 bijection); displayed in header, drives `#seed=xxxxxxx` URL hash for shareable scenarios
- `seedFromHash()` on boot; `history.replaceState` on each load
- Post-reveal: queue peak bar chart per node for post-mortem intuition

### Fonts & Icons
- **Monoid** (regular/bold/italic) and **Phosphor Light** icon font inlined as `@font-face` in `index.html` — no external CSS links
- 14 Phosphor glyphs cherry-picked by unicode codepoint (warning, check-circle, stack, timer, hourglass, etc.)
- Brand: `<span class="brand-wom">WoM</span><span class="brand-bat">bat</span>` — WoM in accent blue, bat in dim

### Testing (`tests/`)
- Mocha + Chai bundled (copied from `murder-it-wrote` project)
- `test_simulator.js`: 11 tests covering queue drop, ASYNC release, SYNC backpressure, fan-out holding, stable baseline, deadline expiry, retry mechanics
- `test_generator.js`: 13 tests across 10 fixed seeds — baseline stability, topology integrity (DAG, valid edges, positive capacities), stressor direction correctness, answer validity
- Several test parameter bugs fixed mid-session (arrival rate too high for ASYNC test, SYNC vs ASYNC stable system, deadline test timing)

## Files Touched

### Core Logic
- **js/simulator.js**: Full implementation — tick engine, SyncAck chain, queue deadline expiry, separate `first_timeout_cascade` tracking
- **js/generator.js**: Full implementation — topology builder, SYNC-aware + load-factor stability analysis, verify-and-adjust, stressor retry loop

### UI
- **js/graph.js**: SVG renderer, layered layout with vertical centering, node interaction
- **js/main.js**: Game orchestration, seed encode/decode, URL hash, verdict display
- **index.html**: App shell; Monoid + Phosphor fonts inlined in `<style>`; favicon + apple-touch-icon; "WoMbat" branding
- **style.css**: Dark terminal theme, Phosphor icon button layout, brand classes

### Config
- **manifest.json**: Name updated to "WoMbat"

### Tests
- **tests/index.html**: Mocha test runner page
- **tests/test_runner.js**: Mocha BDD setup
- **tests/test_simulator.js**: Physics engine tests
- **tests/test_generator.js**: Generator invariant tests

## Known State
- All tests passing as of last run
- "Held stable" edge case eliminated by stressor retry loop
- Fonts served from `fonts/` subdirectory (monoid-*.woff2, phosphor/Phosphor-Light.woff2)
- Favicon at `favicon.ico`, app icon at `icon.png` (wombat, user-supplied)
- Future ideas discussed: retries with load amplification ("hard mode"), circuit breakers, rate limiters, load balancers, multi-stressor scenarios
