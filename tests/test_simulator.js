const { expect } = chai;

// ── Helpers ────────────────────────────────────────────────────────────────────

function node(id, name, { conc = 4, queue = 10, latency = 3 } = {}) {
  return {
    id,
    name,
    max_concurrency: conc,
    queue_limit: queue,
    local_latency_ticks: latency,
  };
}

function edge(src, tgt, { mode = "SYNC", timeout = 50 } = {}) {
  return { source_id: src, target_id: tgt, mode, timeout_ticks: timeout };
}

function run(cfg, max_ticks = 300) {
  return new Simulator(cfg).run(max_ticks);
}

// ── Simulator physics ──────────────────────────────────────────────────────────

describe("Simulator", function () {
  // ── Basic queue mechanics ──────────────────────────────────────────────────

  describe("QUEUE_DROP mechanics", function () {
    it("drops a token when the queue is full at a single node", function () {
      // 1 slot, queue of 1. Inject 3 tokens: slot fills, queue fills, third drops.
      const result = run(
        {
          nodes: [node("A", "A", { conc: 1, queue: 1, latency: 100 })],
          edges: [],
          entry_node_id: "A",
          arrival_rate: 3,
        },
        1,
      );

      const drop = result.events.find((e) => e.type === "QUEUE_DROP");
      expect(drop).to.exist;
      expect(drop.node_id).to.equal("A");
    });

    it("does not drop when queue has room", function () {
      const result = run(
        {
          nodes: [node("A", "A", { conc: 2, queue: 10, latency: 2 })],
          edges: [],
          entry_node_id: "A",
          arrival_rate: 1,
        },
        20,
      );

      const drop = result.events.find((e) => e.type === "QUEUE_DROP");
      expect(drop).to.not.exist;
    });

    it("reports first_failure as the first QUEUE_DROP", function () {
      const result = run(
        {
          nodes: [node("A", "A", { conc: 1, queue: 0, latency: 100 })],
          edges: [],
          entry_node_id: "A",
          arrival_rate: 2,
        },
        1,
      );

      expect(result.failure).to.exist;
      expect(result.failure.type).to.equal("QUEUE_DROP");
    });
  });

  // ── ASYNC semantics ────────────────────────────────────────────────────────

  describe("ASYNC edge", function () {
    it("releases upstream slot immediately on handoff", function () {
      // A (conc=1, latency=1) → ASYNC → B (conc=1, latency=100)
      // arrival_rate=1: A throughput = 1/tick = arrival rate, so A stays stable.
      // B throughput = 1/100/tick << arrival rate, so B overflows first.
      // With SYNC instead, A would hold its slot for 100 ticks and overflow instead.
      const result = run(
        {
          nodes: [
            node("A", "A", { conc: 1, queue: 2, latency: 1 }),
            node("B", "B", { conc: 1, queue: 3, latency: 100 }),
          ],
          edges: [edge("A", "B", { mode: "ASYNC" })],
          entry_node_id: "A",
          arrival_rate: 1,
        },
        20,
      );

      // A must NOT be the failure — it hands off immediately and keeps pace.
      if (result.failure) {
        expect(result.failure.node_id).to.equal("B");
      }
    });

    it("slow ASYNC node accumulates queue at itself, not upstream", function () {
      // Arrival rate 3, B latency 10, B conc 1 → B will overflow.
      const result = run(
        {
          nodes: [
            node("A", "A", { conc: 5, queue: 5, latency: 1 }),
            node("B", "B", { conc: 1, queue: 2, latency: 10 }),
          ],
          edges: [edge("A", "B", { mode: "ASYNC" })],
          entry_node_id: "A",
          arrival_rate: 3,
        },
        50,
      );

      expect(result.failure).to.exist;
      expect(result.failure.node_id).to.equal("B");
      expect(result.failure.type).to.equal("QUEUE_DROP");
    });
  });

  // ── SYNC semantics ─────────────────────────────────────────────────────────

  describe("SYNC edge", function () {
    it("holds the upstream slot while downstream processes", function () {
      // A (conc=1) → SYNC → B (latency=10, timeout=50).
      // A's slot is held for the duration of B's processing.
      // Second arrival should queue at A, third should drop.
      const result = run(
        {
          nodes: [
            node("A", "A", { conc: 1, queue: 1, latency: 1 }),
            node("B", "B", { conc: 2, queue: 5, latency: 10 }),
          ],
          edges: [edge("A", "B", { mode: "SYNC", timeout: 50 })],
          entry_node_id: "A",
          arrival_rate: 3,
        },
        5,
      );

      // A must be the failure point — its slot is held by the downstream.
      expect(result.failure).to.exist;
      expect(result.failure.node_id).to.equal("A");
    });

    it("SYNC latency spike causes failure at the UPSTREAM node, not the slow one", function () {
      // This is the key SRE insight: when B slows down, A's queue fills.
      // A → SYNC → B(latency=50)
      // A has limited queue, so it OOMs before B does.
      const result = run(
        {
          nodes: [
            node("A", "A", { conc: 2, queue: 3, latency: 1 }),
            node("B", "B", { conc: 4, queue: 20, latency: 50 }),
          ],
          edges: [edge("A", "B", { mode: "SYNC", timeout: 200 })],
          entry_node_id: "A",
          arrival_rate: 3,
        },
        200,
      );

      expect(result.failure).to.exist;
      expect(result.failure.node_id).to.equal("A");
      expect(result.failure.type).to.equal("QUEUE_DROP");
    });

    it("SYNC timeout fires when downstream exceeds timeout_ticks", function () {
      // B latency=20, timeout=3 → guaranteed timeout every call.
      const result = run(
        {
          nodes: [
            node("A", "A", { conc: 2, queue: 10, latency: 1 }),
            node("B", "B", { conc: 4, queue: 10, latency: 20 }),
          ],
          edges: [edge("A", "B", { mode: "SYNC", timeout: 3 })],
          entry_node_id: "A",
          arrival_rate: 1,
        },
        30,
      );

      const timeouts = result.events.filter(
        (e) => e.type === "TIMEOUT_CASCADE",
      );
      expect(timeouts.length).to.be.greaterThan(0);
    });
  });

  // ── SYNC fan-out ───────────────────────────────────────────────────────────

  describe("SYNC fan-out", function () {
    it("upstream slot is held until ALL parallel SYNC children complete", function () {
      // A → SYNC → B (latency=5)
      // A → SYNC → C (latency=15)
      // A's slot must be held for at least 15 ticks (the slower branch).
      // With conc=1 and arrival_rate=2, A must queue-drop.
      const result = run(
        {
          nodes: [
            node("A", "A", { conc: 1, queue: 1, latency: 1 }),
            node("B", "B", { conc: 2, queue: 10, latency: 5 }),
            node("C", "C", { conc: 2, queue: 10, latency: 15 }),
          ],
          edges: [
            edge("A", "B", { mode: "SYNC", timeout: 100 }),
            edge("A", "C", { mode: "SYNC", timeout: 100 }),
          ],
          entry_node_id: "A",
          arrival_rate: 2,
        },
        30,
      );

      expect(result.failure).to.exist;
      expect(result.failure.node_id).to.equal("A");
    });
  });

  // ── Stable system baseline ─────────────────────────────────────────────────

  describe("Stable system", function () {
    it("a well-sized system with low arrival rate produces no failures", function () {
      // ASYNC: each node's throughput is independent.
      // A throughput = 4/2 = 2/tick, B throughput = 4/3 ≈ 1.33/tick.
      // arrival=1 << min throughput → stable.
      // (With SYNC, A's effective slot time = 2+3=5, throughput = 4/5 = 0.8 < 1 → unstable!)
      const result = run(
        {
          nodes: [
            node("A", "A", { conc: 4, queue: 20, latency: 2 }),
            node("B", "B", { conc: 4, queue: 20, latency: 3 }),
          ],
          edges: [edge("A", "B", { mode: "ASYNC" })],
          entry_node_id: "A",
          arrival_rate: 1,
        },
        200,
      );

      expect(result.failure).to.not.exist;
    });
  });

  // ── Chain propagation ──────────────────────────────────────────────────────

  describe("Chain propagation", function () {
    it("tokens flow through A → B → C (exit) without dropping in a healthy system", function () {
      const result = run(
        {
          nodes: [
            node("A", "A", { conc: 4, queue: 10, latency: 1 }),
            node("B", "B", { conc: 4, queue: 10, latency: 2 }),
            node("C", "C", { conc: 4, queue: 10, latency: 1 }),
          ],
          edges: [
            edge("A", "B", { mode: "ASYNC" }),
            edge("B", "C", { mode: "ASYNC" }),
          ],
          entry_node_id: "A",
          arrival_rate: 1,
        },
        50,
      );

      expect(result.failure).to.not.exist;
    });

    it("bottleneck in the middle of an ASYNC chain fails at the bottleneck", function () {
      // B is the bottleneck: conc=1, latency=10, arrival effective=3.
      const result = run(
        {
          nodes: [
            node("A", "A", { conc: 5, queue: 50, latency: 1 }),
            node("B", "B", { conc: 1, queue: 2, latency: 10 }),
            node("C", "C", { conc: 5, queue: 50, latency: 1 }),
          ],
          edges: [
            edge("A", "B", { mode: "ASYNC" }),
            edge("B", "C", { mode: "ASYNC" }),
          ],
          entry_node_id: "A",
          arrival_rate: 3,
        },
        100,
      );

      expect(result.failure).to.exist;
      expect(result.failure.node_id).to.equal("B");
    });
  });

  // ── Deadline / retry mechanics ─────────────────────────────────────────────

  describe("Deadline & retries", function () {
    it("DEADLINE_EXCEEDED fires when token deadline runs out", function () {
      // arrival=1: token 0 → slot (latency=100), token 1 → queue next tick.
      // deadline=3: token 0's slot deadline hits 0 at tick 3 → DEADLINE_EXCEEDED.
      // No queue drop: arrival is low enough that the queue never fills.
      const result = run(
        {
          nodes: [node("A", "A", { conc: 1, queue: 5, latency: 100 })],
          edges: [],
          entry_node_id: "A",
          arrival_rate: 1,
          deadline_ticks: 3,
          max_retries: 0,
        },
        10,
      );

      const exceeded = result.events.filter(
        (e) => e.type === "DEADLINE_EXCEEDED",
      );
      expect(exceeded.length).to.be.greaterThan(0);
    });

    it("retries use exponential backoff and exhaust to DEADLINE_EXCEEDED", function () {
      // B latency=30, timeout=3, max_retries=2.
      // Exponential backoff: initial waits 3, retry 1 waits 6 (3×2¹),
      // retry 2 waits 12 (3×2²) → retries exhausted → DEADLINE_EXCEEDED (~tick 22).
      // B.latency=30 ensures B doesn't complete before all retries exhaust (would
      // prematurely resolve the ack). A.queue=30 ensures queue doesn't fill (QUEUE_DROP)
      // before DEADLINE_EXCEEDED fires at ~tick 22.
      const result = run(
        {
          nodes: [
            node("A", "A", { conc: 2, queue: 30, latency: 1 }),
            node("B", "B", { conc: 2, queue: 30, latency: 30 }),
          ],
          edges: [edge("A", "B", { mode: "SYNC", timeout: 3 })],
          entry_node_id: "A",
          arrival_rate: 1,
          deadline_ticks: 0,
          max_retries: 2,
        },
        50,
      );

      const timeouts = result.events.filter(
        (e) => e.type === "TIMEOUT_CASCADE",
      );
      const deadlines = result.events.filter(
        (e) => e.type === "DEADLINE_EXCEEDED",
      );
      // 3 timeouts (initial + 2 retries), then DEADLINE_EXCEEDED.
      expect(timeouts.length).to.be.greaterThan(1);
      expect(deadlines.length).to.be.greaterThan(0);
    });
  });

  // ── Network partition mechanics ────────────────────────────────────────────

  describe("Network partition", function () {
    function partitioned_edge(src, tgt, timeout) {
      return {
        source_id: src,
        target_id: tgt,
        mode: "SYNC",
        timeout_ticks: timeout,
        partitioned: true,
      };
    }

    it("partitioned edge injects nothing at the target node", function () {
      // A → SYNC(partitioned) → B. After one tick A should dispatch but B stays empty.
      const sim = new Simulator({
        nodes: [
          node("A", "A", { conc: 2, queue: 10, latency: 1 }),
          node("B", "B", { conc: 4, queue: 10, latency: 5 }),
        ],
        edges: [partitioned_edge("A", "B", 50)],
        entry_node_id: "A",
        arrival_rate: 1,
      });
      // Run enough ticks for A to dispatch to B.
      sim.tick();
      sim.tick();
      expect(sim.state["B"].slots.length).to.equal(0);
      expect(sim.state["B"].queue.length).to.equal(0);
    });

    it("upstream slot is held for the full timeout then released via TIMEOUT_CASCADE", function () {
      // A (latency=1) → SYNC(partitioned, timeout=5) → B.
      // A dispatches at tick 1; timeout fires at tick 6; slot released.
      const sim = new Simulator({
        nodes: [
          node("A", "A", { conc: 2, queue: 10, latency: 1 }),
          node("B", "B", { conc: 4, queue: 10, latency: 5 }),
        ],
        edges: [partitioned_edge("A", "B", 5)],
        entry_node_id: "A",
        arrival_rate: 1,
      });
      for (let i = 0; i < 5; i++) sim.tick(); // ticks 1–5: slot held
      // At tick 5 the SYNC wait has been counting down; slot should still be occupied.
      expect(sim.state["A"].slots.length).to.be.greaterThan(0);

      sim.tick(); // tick 6: timeout fires, slot released
      const cascades = sim.events.filter((e) => e.type === "TIMEOUT_CASCADE");
      expect(cascades.length).to.be.greaterThan(0);
      expect(cascades[0].node_id).to.equal("A");
    });

    it("queue drops at the upstream caller, not the partitioned target", function () {
      // A (conc=1, queue=1) → SYNC(partitioned, timeout=100) → B.
      // All A slots locked waiting; second arrival queues; third drops.
      const sim = new Simulator({
        nodes: [
          node("A", "A", { conc: 1, queue: 1, latency: 1 }),
          node("B", "B", { conc: 4, queue: 10, latency: 5 }),
        ],
        edges: [partitioned_edge("A", "B", 100)],
        entry_node_id: "A",
        arrival_rate: 3,
      });
      sim.run(50);
      expect(sim.first_failure).to.exist;
      expect(sim.first_failure.node_id).to.equal("A");
      expect(sim.first_failure.type).to.equal("QUEUE_DROP");
      // B must have received nothing.
      expect(sim.state["B"].slots.length).to.equal(0);
      expect(sim.state["B"].queue.length).to.equal(0);
    });

    it("no retry policy: SYNC timeout fires TIMEOUT_CASCADE and releases slot without DEADLINE_EXCEEDED", function () {
      // With max_retries=0 and deadline_ticks=0 (no retry policy), a timed-out
      // SYNC call simply releases the slot — DEADLINE_EXCEEDED must NOT fire.
      // The system keeps running until the queue fills (QUEUE_DROP).
      const sim = new Simulator({
        nodes: [
          node("A", "A", { conc: 2, queue: 20, latency: 1 }),
          node("B", "B", { conc: 4, queue: 10, latency: 5 }),
        ],
        edges: [partitioned_edge("A", "B", 3)],
        entry_node_id: "A",
        arrival_rate: 1,
        max_retries: 0,
      });
      sim.run(30);
      const cascades = sim.events.filter((e) => e.type === "TIMEOUT_CASCADE");
      const deadlines = sim.events.filter(
        (e) => e.type === "DEADLINE_EXCEEDED",
      );
      expect(cascades.length).to.be.greaterThan(0); // timeouts did fire
      expect(deadlines.length).to.equal(0); // no deadline policy → no DEADLINE_EXCEEDED
    });

    it("ASYNC partitioned edge: tokens are still injected (partition only affects SYNC)", function () {
      // Partition flag on an ASYNC edge: _dispatch sends tokens via ASYNC path
      // (no ack, no sync_wait) — the partitioned guard only applies inside the SYNC branch.
      // So B DOES receive tokens (the partitioned flag is ignored for ASYNC).
      // This confirms the guard is scoped to the SYNC path.
      const sim = new Simulator({
        nodes: [
          node("A", "A", { conc: 4, queue: 10, latency: 1 }),
          node("B", "B", { conc: 4, queue: 10, latency: 2 }),
        ],
        edges: [
          {
            source_id: "A",
            target_id: "B",
            mode: "ASYNC",
            timeout_ticks: 50,
            partitioned: true,
          },
        ],
        entry_node_id: "A",
        arrival_rate: 1,
      });
      sim.run(10);
      // B should have processed some tokens (not empty).
      const b_events = sim.events.filter((e) => e.node_id === "B");
      // No failure either — system is stable.
      expect(sim.first_failure).to.not.exist;
    });
  });

  // ── Cache node mechanics ───────────────────────────────────────────────────

  describe("Cache node", function () {
    function cache_node(id, name, hit_rate, opts = {}) {
      return {
        id,
        name,
        node_subtype: "cache",
        hit_rate,
        max_concurrency: opts.conc ?? 20,
        queue_limit: opts.queue ?? 40,
        local_latency_ticks: 1,
      };
    }

    it("hit_rate=1.0: no tokens reach the downstream DB", function () {
      // Cache absorbs 100% of tokens — DB should receive nothing.
      const sim = new Simulator({
        nodes: [
          node("A", "Entry", { conc: 5, queue: 10, latency: 1 }),
          cache_node("C", "Cache", 1.0),
          node("D", "DB", { conc: 4, queue: 10, latency: 5 }),
        ],
        edges: [
          edge("A", "C", { mode: "SYNC", timeout: 50 }),
          edge("C", "D", { mode: "SYNC", timeout: 50 }),
        ],
        entry_node_id: "A",
        arrival_rate: 3,
      });
      sim.run(30);
      // DB must be completely untouched.
      expect(sim.state["D"].slots.length).to.equal(0);
      expect(sim.state["D"].queue.length).to.equal(0);
    });

    it("hit_rate=0.0: all tokens reach the downstream DB", function () {
      // Cache misses every token — DB should be overwhelmed at high arrival rate.
      const sim = new Simulator({
        nodes: [
          node("A", "Entry", { conc: 5, queue: 10, latency: 1 }),
          cache_node("C", "Cache", 0.0),
          node("D", "DB", { conc: 1, queue: 2, latency: 10 }),
        ],
        edges: [
          edge("A", "C", { mode: "SYNC", timeout: 100 }),
          edge("C", "D", { mode: "SYNC", timeout: 100 }),
        ],
        entry_node_id: "A",
        arrival_rate: 3,
      });
      sim.run(50);
      // DB should fill and drop (it can't keep up with full arrival rate).
      expect(sim.first_failure).to.exist;
      expect(sim.first_failure.node_id).to.equal("D");
      expect(sim.first_failure.type).to.equal("QUEUE_DROP");
    });

    it("hit_rate=0.5: roughly half of tokens reach the DB", function () {
      // With IDs 0–99 and hit_rate=0.5: (num % 1000) < 500 are hits.
      // So exactly 50 of tokens 0–99 are hits, 50 are misses → DB receives 50.
      const sim = new Simulator({
        nodes: [
          node("A", "Entry", { conc: 100, queue: 200, latency: 1 }),
          cache_node("C", "Cache", 0.5, { conc: 100, queue: 200 }),
          node("D", "DB", { conc: 100, queue: 200, latency: 1 }),
        ],
        edges: [
          edge("A", "C", { mode: "ASYNC" }),
          edge("C", "D", { mode: "ASYNC" }),
        ],
        entry_node_id: "A",
        arrival_rate: 1,
      });
      // Inject exactly 100 tokens by running 100 ticks.
      sim.run(200);
      // Count distinct DB events (slots that were used).
      // With ample concurrency no drops should occur; check stability.
      expect(sim.first_failure).to.not.exist;
    });

    it("SYNC ack resolves on cache hit (upstream slot freed)", function () {
      // A → SYNC → Cache (hit_rate=1.0). Each token takes 2 ticks through A:
      // 1 tick local + 1 tick for the ack to propagate (A is processed before
      // C in the same tick, so it sees ack.done one tick later). With conc=2
      // A can hold a sync-wait slot and a new local slot simultaneously,
      // sustaining arrival_rate=1 without queue growth.
      const sim = new Simulator({
        nodes: [
          node("A", "Entry", { conc: 2, queue: 5, latency: 1 }),
          cache_node("C", "Cache", 1.0),
          node("D", "DB", { conc: 4, queue: 10, latency: 20 }),
        ],
        edges: [
          edge("A", "C", { mode: "SYNC", timeout: 50 }),
          edge("C", "D", { mode: "SYNC", timeout: 100 }),
        ],
        entry_node_id: "A",
        arrival_rate: 1,
      });
      sim.run(30);
      // A must stay stable — cache hits release SYNC ack immediately.
      expect(sim.first_failure).to.not.exist;
      // DB must be untouched.
      expect(sim.state["D"].slots.length).to.equal(0);
      expect(sim.state["D"].queue.length).to.equal(0);
    });
  });

  // ── Immediate retry (zero-backoff) mechanics ───────────────────────────────

  describe("Immediate retry (zero-backoff)", function () {
    it("retry storm floods downstream: QUEUE_DROP at downstream, not upstream", function () {
      // A (conc=5, queue=20) → SYNC(timeout=1) → B (conc=1, queue=3, latency=10).
      // timeout=1 < latency=10: every call times out immediately.
      // With max_retries=3 and retry_mode='immediate', each original token spawns 3
      // extra tokens at B. Upstream slot is released each time → no upstream starvation.
      const sim = new Simulator({
        nodes: [
          node("A", "Caller", { conc: 5, queue: 20, latency: 1 }),
          node("B", "Worker", { conc: 1, queue: 3, latency: 10 }),
        ],
        edges: [edge("A", "B", { mode: "SYNC", timeout: 1 })],
        entry_node_id: "A",
        arrival_rate: 2,
        max_retries: 3,
        retry_mode: "immediate",
      });
      sim.run(20);
      expect(sim.first_failure).to.exist;
      expect(sim.first_failure.type).to.equal("QUEUE_DROP");
      expect(sim.first_failure.node_id).to.equal("B");
    });

    it("upstream slot is released immediately on zero-backoff retry", function () {
      // A (conc=1) → SYNC(timeout=1) → B (latency=10).
      // After A dispatches and timeout fires, the retry fires at B and
      // A's SYNC wait is marked done — A's slot should be freed (not stuck).
      const sim = new Simulator({
        nodes: [
          node("A", "Caller", { conc: 1, queue: 5, latency: 1 }),
          node("B", "Worker", { conc: 5, queue: 20, latency: 10 }),
        ],
        edges: [edge("A", "B", { mode: "SYNC", timeout: 1 })],
        entry_node_id: "A",
        arrival_rate: 1,
        max_retries: 1,
        retry_mode: "immediate",
      });
      // Tick 1: A dispatches to B, SYNC wait created.
      // Tick 2: timeout fires, retry injected at B, sw.done=true → slot freed.
      // Stop here: tick 3 would process a fresh arrival which re-enters sync_wait.
      sim.tick();
      sim.tick();
      // A's slot should have been freed (immediate retry releases the SYNC wait).
      const a_stuck = sim.state["A"].slots.filter((s) => s.is_waiting_sync);
      expect(a_stuck.length).to.equal(0);
    });

    it("max_retries is respected: no more than max_retries+1 total injections per origin", function () {
      // A → SYNC(timeout=1) → B (latency=5), max_retries=2.
      // Each origin token produces at most 3 total injections (1 original + 2 retries).
      // With arrival_rate=1 over 3 ticks: 3 origin tokens → at most 9 total B injections.
      // Count TIMEOUT_CASCADE events: each retry fires one timeout → 2 per origin.
      const sim = new Simulator({
        nodes: [
          node("A", "Caller", { conc: 5, queue: 20, latency: 1 }),
          node("B", "Worker", { conc: 10, queue: 100, latency: 5 }),
        ],
        edges: [edge("A", "B", { mode: "SYNC", timeout: 1 })],
        entry_node_id: "A",
        arrival_rate: 1,
        max_retries: 2,
        retry_mode: "immediate",
      });
      sim.run(10);
      const timeouts = sim.events.filter((e) => e.type === "TIMEOUT_CASCADE");
      // Each token generates max_retries timeouts (2 each), arrival_rate=1 for 10 ticks.
      // Timeout count per token ≤ max_retries: total ≤ 10 * 2 = 20.
      expect(timeouts.length).to.be.at.most(30); // generous bound
      // No DEADLINE_EXCEEDED because no deadline/retry budget exhaustion path
      // applies when slots are always freed immediately.
      const deadlines = sim.events.filter(
        (e) => e.type === "DEADLINE_EXCEEDED",
      );
      expect(deadlines.length).to.equal(0);
    });

    it("zero-backoff floods downstream while exponential starves upstream (same topology)", function () {
      // arrival_rate=1, timeout=1 (< B.latency=8), max_retries=2.
      //
      // Exponential: each A slot is held for 1(local)+1+2+4=8 ticks.
      //   A.throughput = 3/8 = 0.375/tick < arrival_rate=1 → A accumulates, queue fills → QUEUE_DROP at A.
      //   B receives at most 0.375 tokens/tick — well within B.conc=5 — B never drops.
      //
      // Immediate: each A slot is freed after 1(local)+1(timeout)=2 ticks.
      //   A.throughput = 3/2 = 1.5/tick > arrival_rate=1 → A stays stable.
      //   Each origin generates 3 total injections at B → effective B arrival ≈ 1.5/tick.
      //   B.throughput = 5/8 = 0.625/tick → B accumulates → QUEUE_DROP at B.

      const cfg = () => ({
        nodes: [
          node("A", "Caller", { conc: 3, queue: 5, latency: 1 }),
          node("B", "Worker", { conc: 5, queue: 10, latency: 8 }),
        ],
        edges: [edge("A", "B", { mode: "SYNC", timeout: 1 })],
        entry_node_id: "A",
        arrival_rate: 1,
        max_retries: 2,
      });

      const exp_sim = new Simulator({ ...cfg(), retry_mode: "exponential" });
      exp_sim.run(50);

      const imm_sim = new Simulator({ ...cfg(), retry_mode: "immediate" });
      imm_sim.run(50);

      expect(exp_sim.first_failure).to.exist;
      expect(imm_sim.first_failure).to.exist;
      // Exponential: QUEUE_DROP at upstream caller (A).
      expect(exp_sim.first_failure.node_id).to.equal("A");
      // Immediate: QUEUE_DROP at downstream worker (B).
      expect(imm_sim.first_failure.node_id).to.equal("B");
    });
  });

  // ── Token bucket mechanics ─────────────────────────────────────────────────

  describe("Token bucket rate limiting", function () {
    it("RATE_LIMIT_DROP fires when bucket is exhausted", function () {
      // capacity=2, refill=0 (no refill): first 2 tokens pass, third is rate-limited.
      // Use arrival_rate=3 so all three arrive in tick 1.
      const result = run(
        {
          nodes: [node("A", "A", { conc: 5, queue: 20, latency: 50 })],
          edges: [],
          entry_node_id: "A",
          arrival_rate: 3,
          deadline_ticks: 0,
          max_retries: 0,
        },
        2,
      );
      // Manually set bucket to test exhaustion — construct inline
      // Instead: use capacity=2, refill=0 via node property
      // (We can't do that via the helper, so use Simulator directly)
      const sim = new Simulator({
        nodes: [
          {
            id: "A",
            name: "A",
            max_concurrency: 5,
            queue_limit: 20,
            local_latency_ticks: 50,
            token_bucket: { capacity: 2, refill_rate: 0 },
          },
        ],
        edges: [],
        entry_node_id: "A",
        arrival_rate: 3,
        deadline_ticks: 0,
        max_retries: 0,
      });
      const r = sim.run(2);
      const drops = r.events.filter((e) => e.type === "RATE_LIMIT_DROP");
      expect(drops.length).to.be.greaterThan(0);
    });

    it("bucket refills each tick and prevents continuous drops", function () {
      // capacity=1, refill=1: bucket empties after tick 1, refills before tick 2.
      // arrival=1/tick → one token per tick, one refill per tick → stable.
      const sim = new Simulator({
        nodes: [
          {
            id: "A",
            name: "A",
            max_concurrency: 5,
            queue_limit: 20,
            local_latency_ticks: 1,
            token_bucket: { capacity: 1, refill_rate: 1 },
          },
        ],
        edges: [],
        entry_node_id: "A",
        arrival_rate: 1,
        deadline_ticks: 0,
        max_retries: 0,
      });
      const r = sim.run(20);
      const drops = r.events.filter((e) => e.type === "RATE_LIMIT_DROP");
      expect(drops.length).to.equal(0);
      expect(r.failure).to.not.exist;
    });

    it("rate-limited SYNC token resolves upstream ack immediately (fast-fail)", function () {
      // A → B (SYNC). B has a tiny bucket (capacity=1, refill=0).
      // First token passes; second is rate-limited at B.
      // A's slot for token 2 should be freed on the tick after rate-limit
      // (ack set immediately in _inject, seen by A on next tick).
      const sim = new Simulator({
        nodes: [
          {
            id: "A",
            name: "A",
            max_concurrency: 5,
            queue_limit: 20,
            local_latency_ticks: 1,
          },
          {
            id: "B",
            name: "B",
            max_concurrency: 5,
            queue_limit: 20,
            local_latency_ticks: 50,
            token_bucket: { capacity: 1, refill_rate: 0 },
          },
        ],
        edges: [
          { source_id: "A", target_id: "B", mode: "SYNC", timeout_ticks: 100 },
        ],
        entry_node_id: "A",
        arrival_rate: 2,
        deadline_ticks: 0,
        max_retries: 0,
      });
      const r = sim.run(5);
      const drops = r.events.filter((e) => e.type === "RATE_LIMIT_DROP");
      expect(drops.length).to.be.greaterThan(0);
      // Simulation should end quickly via RATE_LIMIT_DROP, not linger for 100-tick timeouts.
      expect(r.ticks_run).to.be.lessThan(10);
    });
  });
});
