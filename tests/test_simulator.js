const { expect } = chai;

// ── Helpers ────────────────────────────────────────────────────────────────────

function node(id, name, { conc = 4, queue = 10, latency = 3 } = {}) {
  return { id, name, max_concurrency: conc, queue_limit: queue, local_latency_ticks: latency };
}

function edge(src, tgt, { mode = 'SYNC', timeout = 50 } = {}) {
  return { source_id: src, target_id: tgt, mode, timeout_ticks: timeout };
}

function run(cfg, max_ticks = 300) {
  return new Simulator(cfg).run(max_ticks);
}

// ── Simulator physics ──────────────────────────────────────────────────────────

describe('Simulator', function () {

  // ── Basic queue mechanics ──────────────────────────────────────────────────

  describe('QUEUE_DROP mechanics', function () {

    it('drops a token when the queue is full at a single node', function () {
      // 1 slot, queue of 1. Inject 3 tokens: slot fills, queue fills, third drops.
      const result = run({
        nodes: [node('A', 'A', { conc: 1, queue: 1, latency: 100 })],
        edges: [],
        entry_node_id: 'A',
        arrival_rate: 3,
      }, 1);

      const drop = result.events.find(e => e.type === 'QUEUE_DROP');
      expect(drop).to.exist;
      expect(drop.node_id).to.equal('A');
    });

    it('does not drop when queue has room', function () {
      const result = run({
        nodes: [node('A', 'A', { conc: 2, queue: 10, latency: 2 })],
        edges: [],
        entry_node_id: 'A',
        arrival_rate: 1,
      }, 20);

      const drop = result.events.find(e => e.type === 'QUEUE_DROP');
      expect(drop).to.not.exist;
    });

    it('reports first_failure as the first QUEUE_DROP', function () {
      const result = run({
        nodes: [node('A', 'A', { conc: 1, queue: 0, latency: 100 })],
        edges: [],
        entry_node_id: 'A',
        arrival_rate: 2,
      }, 1);

      expect(result.failure).to.exist;
      expect(result.failure.type).to.equal('QUEUE_DROP');
    });

  });

  // ── ASYNC semantics ────────────────────────────────────────────────────────

  describe('ASYNC edge', function () {

    it('releases upstream slot immediately on handoff', function () {
      // A (conc=1, latency=1) → ASYNC → B (conc=1, latency=100)
      // arrival_rate=1: A throughput = 1/tick = arrival rate, so A stays stable.
      // B throughput = 1/100/tick << arrival rate, so B overflows first.
      // With SYNC instead, A would hold its slot for 100 ticks and overflow instead.
      const result = run({
        nodes: [
          node('A', 'A', { conc: 1, queue: 2,  latency: 1 }),
          node('B', 'B', { conc: 1, queue: 3, latency: 100 }),
        ],
        edges: [edge('A', 'B', { mode: 'ASYNC' })],
        entry_node_id: 'A',
        arrival_rate: 1,
      }, 20);

      // A must NOT be the failure — it hands off immediately and keeps pace.
      if (result.failure) {
        expect(result.failure.node_id).to.equal('B');
      }
    });

    it('slow ASYNC node accumulates queue at itself, not upstream', function () {
      // Arrival rate 3, B latency 10, B conc 1 → B will overflow.
      const result = run({
        nodes: [
          node('A', 'A', { conc: 5, queue: 5,  latency: 1 }),
          node('B', 'B', { conc: 1, queue: 2, latency: 10 }),
        ],
        edges: [edge('A', 'B', { mode: 'ASYNC' })],
        entry_node_id: 'A',
        arrival_rate: 3,
      }, 50);

      expect(result.failure).to.exist;
      expect(result.failure.node_id).to.equal('B');
      expect(result.failure.type).to.equal('QUEUE_DROP');
    });

  });

  // ── SYNC semantics ─────────────────────────────────────────────────────────

  describe('SYNC edge', function () {

    it('holds the upstream slot while downstream processes', function () {
      // A (conc=1) → SYNC → B (latency=10, timeout=50).
      // A's slot is held for the duration of B's processing.
      // Second arrival should queue at A, third should drop.
      const result = run({
        nodes: [
          node('A', 'A', { conc: 1, queue: 1, latency: 1 }),
          node('B', 'B', { conc: 2, queue: 5, latency: 10 }),
        ],
        edges: [edge('A', 'B', { mode: 'SYNC', timeout: 50 })],
        entry_node_id: 'A',
        arrival_rate: 3,
      }, 5);

      // A must be the failure point — its slot is held by the downstream.
      expect(result.failure).to.exist;
      expect(result.failure.node_id).to.equal('A');
    });

    it('SYNC latency spike causes failure at the UPSTREAM node, not the slow one', function () {
      // This is the key SRE insight: when B slows down, A's queue fills.
      // A → SYNC → B(latency=50)
      // A has limited queue, so it OOMs before B does.
      const result = run({
        nodes: [
          node('A', 'A', { conc: 2, queue: 3,  latency: 1 }),
          node('B', 'B', { conc: 4, queue: 20, latency: 50 }),
        ],
        edges: [edge('A', 'B', { mode: 'SYNC', timeout: 200 })],
        entry_node_id: 'A',
        arrival_rate: 3,
      }, 200);

      expect(result.failure).to.exist;
      expect(result.failure.node_id).to.equal('A');
      expect(result.failure.type).to.equal('QUEUE_DROP');
    });

    it('SYNC timeout fires when downstream exceeds timeout_ticks', function () {
      // B latency=20, timeout=3 → guaranteed timeout every call.
      const result = run({
        nodes: [
          node('A', 'A', { conc: 2, queue: 10, latency: 1 }),
          node('B', 'B', { conc: 4, queue: 10, latency: 20 }),
        ],
        edges: [edge('A', 'B', { mode: 'SYNC', timeout: 3 })],
        entry_node_id: 'A',
        arrival_rate: 1,
      }, 30);

      const timeouts = result.events.filter(e => e.type === 'TIMEOUT_CASCADE');
      expect(timeouts.length).to.be.greaterThan(0);
    });

  });

  // ── SYNC fan-out ───────────────────────────────────────────────────────────

  describe('SYNC fan-out', function () {

    it('upstream slot is held until ALL parallel SYNC children complete', function () {
      // A → SYNC → B (latency=5)
      // A → SYNC → C (latency=15)
      // A's slot must be held for at least 15 ticks (the slower branch).
      // With conc=1 and arrival_rate=2, A must queue-drop.
      const result = run({
        nodes: [
          node('A', 'A', { conc: 1, queue: 1,  latency: 1 }),
          node('B', 'B', { conc: 2, queue: 10, latency: 5 }),
          node('C', 'C', { conc: 2, queue: 10, latency: 15 }),
        ],
        edges: [
          edge('A', 'B', { mode: 'SYNC', timeout: 100 }),
          edge('A', 'C', { mode: 'SYNC', timeout: 100 }),
        ],
        entry_node_id: 'A',
        arrival_rate: 2,
      }, 30);

      expect(result.failure).to.exist;
      expect(result.failure.node_id).to.equal('A');
    });

  });

  // ── Stable system baseline ─────────────────────────────────────────────────

  describe('Stable system', function () {

    it('a well-sized system with low arrival rate produces no failures', function () {
      // ASYNC: each node's throughput is independent.
      // A throughput = 4/2 = 2/tick, B throughput = 4/3 ≈ 1.33/tick.
      // arrival=1 << min throughput → stable.
      // (With SYNC, A's effective slot time = 2+3=5, throughput = 4/5 = 0.8 < 1 → unstable!)
      const result = run({
        nodes: [
          node('A', 'A', { conc: 4, queue: 20, latency: 2 }),
          node('B', 'B', { conc: 4, queue: 20, latency: 3 }),
        ],
        edges: [edge('A', 'B', { mode: 'ASYNC' })],
        entry_node_id: 'A',
        arrival_rate: 1,
      }, 200);

      expect(result.failure).to.not.exist;
    });

  });

  // ── Chain propagation ──────────────────────────────────────────────────────

  describe('Chain propagation', function () {

    it('tokens flow through A → B → C (exit) without dropping in a healthy system', function () {
      const result = run({
        nodes: [
          node('A', 'A', { conc: 4, queue: 10, latency: 1 }),
          node('B', 'B', { conc: 4, queue: 10, latency: 2 }),
          node('C', 'C', { conc: 4, queue: 10, latency: 1 }),
        ],
        edges: [
          edge('A', 'B', { mode: 'ASYNC' }),
          edge('B', 'C', { mode: 'ASYNC' }),
        ],
        entry_node_id: 'A',
        arrival_rate: 1,
      }, 50);

      expect(result.failure).to.not.exist;
    });

    it('bottleneck in the middle of an ASYNC chain fails at the bottleneck', function () {
      // B is the bottleneck: conc=1, latency=10, arrival effective=3.
      const result = run({
        nodes: [
          node('A', 'A', { conc: 5, queue: 50, latency: 1 }),
          node('B', 'B', { conc: 1, queue: 2,  latency: 10 }),
          node('C', 'C', { conc: 5, queue: 50, latency: 1 }),
        ],
        edges: [
          edge('A', 'B', { mode: 'ASYNC' }),
          edge('B', 'C', { mode: 'ASYNC' }),
        ],
        entry_node_id: 'A',
        arrival_rate: 3,
      }, 100);

      expect(result.failure).to.exist;
      expect(result.failure.node_id).to.equal('B');
    });

  });

  // ── Deadline / retry mechanics ─────────────────────────────────────────────

  describe('Deadline & retries', function () {

    it('DEADLINE_EXCEEDED fires when token deadline runs out', function () {
      // arrival=1: token 0 → slot (latency=100), token 1 → queue next tick.
      // deadline=3: token 0's slot deadline hits 0 at tick 3 → DEADLINE_EXCEEDED.
      // No queue drop: arrival is low enough that the queue never fills.
      const result = run({
        nodes: [node('A', 'A', { conc: 1, queue: 5, latency: 100 })],
        edges: [],
        entry_node_id: 'A',
        arrival_rate: 1,
        deadline_ticks: 3,
        max_retries: 0,
      }, 10);

      const exceeded = result.events.filter(e => e.type === 'DEADLINE_EXCEEDED');
      expect(exceeded.length).to.be.greaterThan(0);
    });

    it('retries use exponential backoff and exhaust to DEADLINE_EXCEEDED', function () {
      // B latency=30, timeout=3, max_retries=2.
      // Exponential backoff: initial waits 3, retry 1 waits 6 (3×2¹),
      // retry 2 waits 12 (3×2²) → retries exhausted → DEADLINE_EXCEEDED (~tick 22).
      // B.latency=30 ensures B doesn't complete before all retries exhaust (would
      // prematurely resolve the ack). A.queue=30 ensures queue doesn't fill (QUEUE_DROP)
      // before DEADLINE_EXCEEDED fires at ~tick 22.
      const result = run({
        nodes: [
          node('A', 'A', { conc: 2, queue: 30, latency: 1 }),
          node('B', 'B', { conc: 2, queue: 30, latency: 30 }),
        ],
        edges: [edge('A', 'B', { mode: 'SYNC', timeout: 3 })],
        entry_node_id: 'A',
        arrival_rate: 1,
        deadline_ticks: 0,
        max_retries: 2,
      }, 50);

      const timeouts  = result.events.filter(e => e.type === 'TIMEOUT_CASCADE');
      const deadlines = result.events.filter(e => e.type === 'DEADLINE_EXCEEDED');
      // 3 timeouts (initial + 2 retries), then DEADLINE_EXCEEDED.
      expect(timeouts.length).to.be.greaterThan(1);
      expect(deadlines.length).to.be.greaterThan(0);
    });

  });

  // ── Token bucket mechanics ─────────────────────────────────────────────────

  describe('Token bucket rate limiting', function () {

    it('RATE_LIMIT_DROP fires when bucket is exhausted', function () {
      // capacity=2, refill=0 (no refill): first 2 tokens pass, third is rate-limited.
      // Use arrival_rate=3 so all three arrive in tick 1.
      const result = run({
        nodes: [node('A', 'A', { conc: 5, queue: 20, latency: 50 })],
        edges: [],
        entry_node_id: 'A',
        arrival_rate: 3,
        deadline_ticks: 0,
        max_retries: 0,
      }, 2);
      // Manually set bucket to test exhaustion — construct inline
      // Instead: use capacity=2, refill=0 via node property
      // (We can't do that via the helper, so use Simulator directly)
      const sim = new Simulator({
        nodes: [{ id: 'A', name: 'A', max_concurrency: 5, queue_limit: 20,
                  local_latency_ticks: 50, token_bucket: { capacity: 2, refill_rate: 0 } }],
        edges: [],
        entry_node_id: 'A',
        arrival_rate: 3,
        deadline_ticks: 0,
        max_retries: 0,
      });
      const r = sim.run(2);
      const drops = r.events.filter(e => e.type === 'RATE_LIMIT_DROP');
      expect(drops.length).to.be.greaterThan(0);
    });

    it('bucket refills each tick and prevents continuous drops', function () {
      // capacity=1, refill=1: bucket empties after tick 1, refills before tick 2.
      // arrival=1/tick → one token per tick, one refill per tick → stable.
      const sim = new Simulator({
        nodes: [{ id: 'A', name: 'A', max_concurrency: 5, queue_limit: 20,
                  local_latency_ticks: 1, token_bucket: { capacity: 1, refill_rate: 1 } }],
        edges: [],
        entry_node_id: 'A',
        arrival_rate: 1,
        deadline_ticks: 0,
        max_retries: 0,
      });
      const r = sim.run(20);
      const drops = r.events.filter(e => e.type === 'RATE_LIMIT_DROP');
      expect(drops.length).to.equal(0);
      expect(r.failure).to.not.exist;
    });

    it('rate-limited SYNC token resolves upstream ack immediately (fast-fail)', function () {
      // A → B (SYNC). B has a tiny bucket (capacity=1, refill=0).
      // First token passes; second is rate-limited at B.
      // A's slot for token 2 should be freed on the tick after rate-limit
      // (ack set immediately in _inject, seen by A on next tick).
      const sim = new Simulator({
        nodes: [
          { id: 'A', name: 'A', max_concurrency: 5, queue_limit: 20, local_latency_ticks: 1 },
          { id: 'B', name: 'B', max_concurrency: 5, queue_limit: 20, local_latency_ticks: 50,
            token_bucket: { capacity: 1, refill_rate: 0 } },
        ],
        edges: [{ source_id: 'A', target_id: 'B', mode: 'SYNC', timeout_ticks: 100 }],
        entry_node_id: 'A',
        arrival_rate: 2,
        deadline_ticks: 0,
        max_retries: 0,
      });
      const r = sim.run(5);
      const drops = r.events.filter(e => e.type === 'RATE_LIMIT_DROP');
      expect(drops.length).to.be.greaterThan(0);
      // Simulation should end quickly via RATE_LIMIT_DROP, not linger for 100-tick timeouts.
      expect(r.ticks_run).to.be.lessThan(10);
    });

  });

});
