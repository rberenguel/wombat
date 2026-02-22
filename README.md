# <img src="icon.png" alt="WoMbat Icon" width="32" height="32"> WoMbat — Wheel of Misfortune

A browser-based distributed systems puzzle game. Each round procedurally generates a small service architecture, applies a stressor, and asks you to predict where it fails before revealing the simulation result.

An experiment. No backend, no build step.

## How it Works

A seeded RNG builds a DAG of 3–8 nodes arranged in layers. Each node has concurrency slots, a queue, a latency, and optionally a token bucket. Edges between nodes are either SYNC (upstream holds its concurrency slot until downstream completes) or ASYNC (upstream releases immediately). The entry node receives a steady arrival rate; downstream nodes receive forwarded tokens.

A stressor is then applied — latency spike, concurrency crush, arrival surge, misconfigured timeout, quota identity bug, or network partition. The simulator runs a discrete-event tick loop until a terminal failure occurs: queue drop, timeout cascade, deadline exceeded, or rate limit drop.

Your job is to pick the failing node and the failure type before the answer is revealed.

### Simulation

`js/simulator.js` — tick loop with `Token`, `Slot`, `NodeState`, and `SyncAck` classes. SYNC fan-out holds the upstream slot until all branches resolve. Exponential backoff retries (for timeout scenarios) hold the slot for T + 2T + 4T ticks before a deadline-exceeded fires. Network-partitioned edges black-hole tokens silently: the upstream SYNC caller waits the full timeout on every call with no signal that the downstream is gone.

### Generator

`js/generator.js` — topology builder with 8 DAG templates (some rare). Stability analysis walks SYNC chains recursively to compute effective slot time, then uses a topological load-factor pass to account for fan-in multipliers. A verify-and-adjust loop runs the baseline simulation to confirm stability before applying a stressor. If a stressor leaves the system stable, it cycles through the remaining types.

### Renderer

`js/graph.js` — pure SVG, no library. Layered layout with vertical centering per layer. Nodes are clickable for the guess phase; post-reveal highlights correct (green) and wrong (red). Partitioned edges render as a red dashed line with a PARTITIONED label.

### UI

`js/main.js` + `index.html` + `style.css` — three-panel layout: incident description → architecture graph → diagnosis → result. The 7-letter code in the header encodes the 32-bit seed (base-26 bijection); clicking it fixes the URL hash so the scenario is shareable. A `?` button in the architecture panel opens a modal explaining how to read node stats and edge semantics.

### Tests

`tests/` — Mocha + Chai. Covers simulator physics (queue drop, backpressure, deadlines, token buckets, network partitions) and generator invariants (baseline stability, topology integrity, stressor direction, answer validity).

## Stressors

| Stressor | What changes | Expected failure |
|---|---|---|
| Latency Spike | One node's processing time spikes 6–10× | Queue Drop upstream |
| Concurrency Crush | One node's thread pool shrinks to ⅓ | Queue Drop upstream |
| Arrival Spike | Entry rate multiplies 3–5× | Queue Drop at tightest bottleneck |
| Timeout Trap | A SYNC edge timeout set below downstream latency; 2 retries with exp. backoff | Deadline Exceeded |
| Quota Identity Bug | A token bucket collapses to 10% capacity/refill | Rate Limited |
| Network Partition | A SYNC edge silently black-holes all packets | Queue Drop at caller |

## Failure Modes

| Answer | Meaning |
|---|---|
| Queue Drop | Arrivals exceed throughput; buffer fills and drops |
| Timeout Cascade | SYNC calls timing out; system degraded but alive |
| Deadline Exceeded | Retry budget exhausted (exp. backoff); slot held 7T ticks total |
| Rate Limited | Token bucket drained faster than it refills |

## Fonts

- **[Monoid](https://larsenwork.com/monoid/)** — by Andreas Larsen (SIL OFL 1.1)
- **[Phosphor Icons](https://phosphoricons.com/)** — open-source icon family (MIT)

## Test Libraries

- **[Mocha](https://mochajs.org/)** — test framework (MIT)
- **[Chai](https://www.chaijs.com/)** — assertion library (MIT)
