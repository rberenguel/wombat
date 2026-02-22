# <img src="icon.png" alt="WoMbat Icon" width="32" height="32"> WoMbat — Wheel of Misfortune

A browser-based distributed systems puzzle game. Each round procedurally generates a small service architecture, applies a stressor, and asks you to predict where it fails before revealing the simulation result.

An experiment. No backend, no build step.

## How it Works

A seeded RNG builds a DAG of 3–8 nodes arranged in layers. Each node has concurrency slots, a queue, a latency, and optionally a token bucket. Edges between nodes are either SYNC (upstream holds its concurrency slot until downstream completes) or ASYNC (upstream releases immediately). The entry node receives a steady arrival rate; downstream nodes receive forwarded tokens.

A stressor is then applied — latency spike, concurrency crush, arrival surge, misconfigured timeout, quota identity bug, network partition, cache flush, aggressive retries, or circuit breaker flap. The simulator runs a discrete-event tick loop until a terminal failure occurs: queue drop, timeout cascade, deadline exceeded, rate limit drop, or circuit open.

Your job is to pick the failing node and the failure type before the answer is revealed.

### Simulation

`js/simulator.js` — tick loop with `Token`, `Slot`, `NodeState`, and `SyncAck` classes. SYNC fan-out holds the upstream slot until all branches resolve. Two retry modes: exponential backoff (slot held for T + 2T + 4T before deadline-exceeded fires) and zero-backoff immediate (slot released on each timeout, retry token fire-and-forget to downstream — flooding it). Cache nodes short-circuit on hit, skipping all downstream edges. Network-partitioned edges black-hole tokens silently: the upstream SYNC caller waits the full timeout on every call with no signal that the downstream is gone. Circuit breakers track SYNC timeout counts in a sliding window; once the threshold is crossed the breaker trips and every subsequent injection fast-fails immediately (CB_OPEN_DROP), freeing the upstream ack without holding the slot.

### Generator

`js/generator.js` — topology builder with 8 DAG templates (some rare). Stability analysis walks SYNC chains recursively to compute effective slot time, then uses a topological load-factor pass to account for fan-in multipliers. A verify-and-adjust loop runs the baseline simulation to confirm stability before applying a stressor. If a stressor leaves the system stable, it cycles through the remaining types. After baseline stabilisation, ~25% of non-entry SYNC-target nodes receive a circuit breaker configuration.

### Renderer

`js/graph.js` — pure SVG, no library. Layered layout with vertical centering per layer. Nodes are clickable for the guess phase; post-reveal highlights correct (green) and wrong (red). Partitioned edges render as a red dashed line with a PARTITIONED label.

### UI

`js/main.js` + `index.html` + `style.css` — three-panel layout: incident description → architecture graph → diagnosis → result. The 7-letter code in the header encodes the 32-bit seed (base-26 bijection); clicking it fixes the URL hash so the scenario is shareable. A `?` button in the architecture panel opens a modal explaining how to read node stats and edge semantics.

### Tests

`tests/` — Mocha + Chai. Covers simulator physics (queue drop, backpressure, deadlines, token buckets, network partitions, cache hit/miss, immediate vs exponential retry, circuit breaker trip/reset/fast-fail) and generator invariants (baseline stability, topology integrity, stressor direction, answer validity, CB node placement).

## Stressors

| Stressor             | What changes                                                                                                                                           | Expected failure                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Latency Spike        | One node's processing time spikes 6–10×                                                                                                                | Queue Drop upstream               |
| Concurrency Crush    | One node's thread pool shrinks to ⅓                                                                                                                    | Queue Drop upstream               |
| Arrival Spike        | Entry rate multiplies 3–5×                                                                                                                             | Queue Drop at tightest bottleneck |
| Timeout Trap         | A SYNC edge timeout set below downstream latency; 2 retries with exp. backoff                                                                          | Deadline Exceeded                 |
| Quota Identity Bug   | A token bucket collapses to 10% capacity/refill                                                                                                        | Rate Limited                      |
| Network Partition    | A SYNC edge silently black-holes all packets                                                                                                           | Queue Drop at caller              |
| Cache Flush          | Cache hit rate drops to 0%; every request punches through to the DB                                                                                    | Queue Drop at DB                  |
| Aggressive Retries   | Zero-backoff retries on a tight timeout; each call spawns up to 4× downstream load                                                                     | Queue Drop at downstream          |
| Circuit Breaker Flap | CB threshold misconfigured to 1 + timeout shortened; first SYNC timeout trips the breaker, fast-failing all subsequent traffic for the cooldown period | Circuit Open at target            |

## Failure Modes

| Answer            | Meaning                                                             |
| ----------------- | ------------------------------------------------------------------- |
| Queue Drop        | Arrivals exceed throughput; buffer fills and drops                  |
| Timeout Cascade   | SYNC calls timing out; system degraded but alive                    |
| Deadline Exceeded | Retry budget exhausted (exp. backoff); slot held 7T ticks total     |
| Rate Limited      | Token bucket drained faster than it refills                         |
| Circuit Open      | Breaker tripped; all injections fast-failed for the cooldown period |

## Fonts

- **[Monoid](https://larsenwork.com/monoid/)** — by Andreas Larsen (SIL OFL 1.1)
- **[Phosphor Icons](https://phosphoricons.com/)** — open-source icon family (MIT)

## Test Libraries

- **[Mocha](https://mochajs.org/)** — test framework (MIT)
- **[Chai](https://www.chaijs.com/)** — assertion library (MIT)
