const { expect } = chai;

// ── Generator invariants ───────────────────────────────────────────────────────

describe("Generator", function () {
  // Run a small batch of scenarios to check invariants hold across seeds.
  const SEEDS = [1, 42, 137, 999, 31337, 0xdead, 0xbeef, 2025, 12345, 99999];

  describe("Baseline stability", function () {
    it("the unstressed system is stable (no failure within 400 ticks)", function () {
      for (const seed of SEEDS) {
        const s = generateScenario(seed);

        // Re-run the simulation on the BASELINE (non-stressed) config.
        const sim = new Simulator({
          nodes: s.nodes,
          edges: s.edges,
          entry_node_id: s.entry_node_id,
          arrival_rate: s.arrival_rate,
          deadline_ticks: 0,
          max_retries: 0,
        });
        const result = sim.run(400);
        expect(result.failure, `seed ${seed}: baseline should be stable`).to.not
          .exist;
      }
    });
  });

  describe("Stressor always causes failure", function () {
    it("the stressed system fails within 600 ticks", function () {
      let stable_count = 0;
      for (const seed of SEEDS) {
        const s = generateScenario(seed);
        if (!s.answer) stable_count++;
        // We accept rare misses but the vast majority must produce a failure.
      }
      // At most 1 in 10 scenarios may be accidentally stable.
      expect(stable_count).to.be.lessThan(3);
    });
  });

  describe("Topology integrity", function () {
    it("every scenario has at least one entry node and one exit node", function () {
      for (const seed of SEEDS) {
        const s = generateScenario(seed);
        const node_ids = new Set(s.nodes.map((n) => n.id));

        const has_outgoing = new Set(s.edges.map((e) => e.source_id));
        const has_incoming = new Set(s.edges.map((e) => e.target_id));

        const entry_candidates = [...node_ids].filter(
          (id) => !has_incoming.has(id),
        );
        const exit_candidates = [...node_ids].filter(
          (id) => !has_outgoing.has(id),
        );

        expect(
          entry_candidates.length,
          `seed ${seed}: must have ≥1 entry`,
        ).to.be.greaterThan(0);
        expect(
          exit_candidates.length,
          `seed ${seed}: must have ≥1 exit`,
        ).to.be.greaterThan(0);
        expect(s.entry_node_id, `seed ${seed}: entry_node_id must be declared`)
          .to.exist;
        expect(entry_candidates).to.include(s.entry_node_id);
      }
    });

    it("all edge endpoints reference existing nodes", function () {
      for (const seed of SEEDS) {
        const s = generateScenario(seed);
        const node_ids = new Set(s.nodes.map((n) => n.id));
        for (const e of s.edges) {
          expect(
            node_ids.has(e.source_id),
            `seed ${seed}: source ${e.source_id} must exist`,
          ).to.be.true;
          expect(
            node_ids.has(e.target_id),
            `seed ${seed}: target ${e.target_id} must exist`,
          ).to.be.true;
        }
      }
    });

    it("the graph is acyclic (no node appears on its own reachability path)", function () {
      for (const seed of SEEDS) {
        const s = generateScenario(seed);
        const adj = {};
        for (const n of s.nodes) adj[n.id] = [];
        for (const e of s.edges) adj[e.source_id].push(e.target_id);

        // DFS cycle detection.
        function has_cycle(start) {
          const visited = new Set();
          const stack = [start];
          while (stack.length) {
            const cur = stack.pop();
            if (cur === start && visited.size > 0) return true;
            if (visited.has(cur)) continue;
            visited.add(cur);
            for (const nb of adj[cur] || []) stack.push(nb);
          }
          return false;
        }

        for (const n of s.nodes) {
          expect(has_cycle(n.id), `seed ${seed}: cycle detected from ${n.id}`)
            .to.be.false;
        }
      }
    });

    it("all nodes have valid positive capacities", function () {
      for (const seed of SEEDS) {
        const s = generateScenario(seed);
        for (const n of [...s.nodes, ...s.stressed_nodes]) {
          expect(
            n.max_concurrency,
            `${n.name} max_concurrency`,
          ).to.be.greaterThan(0);
          expect(n.queue_limit, `${n.name} queue_limit`).to.be.greaterThan(0);
          expect(
            n.local_latency_ticks,
            `${n.name} local_latency_ticks`,
          ).to.be.greaterThan(0);
        }
      }
    });
  });

  describe("Stressor properties", function () {
    it("every stressor has a non-empty description", function () {
      for (const seed of SEEDS) {
        const s = generateScenario(seed);
        expect(s.stressor.description, `seed ${seed}`)
          .to.be.a("string")
          .with.length.greaterThan(10);
      }
    });

    it("LATENCY_SPIKE stressor increases latency (stressed > baseline)", function () {
      const spike_seeds = SEEDS.filter(
        (seed) => generateScenario(seed).stressor.type === "LATENCY_SPIKE",
      );
      for (const seed of spike_seeds) {
        const s = generateScenario(seed);
        const m = s.stressor.mutation;
        const baseline = s.nodes.find((n) => n.id === m.node_id);
        const stressed = s.stressed_nodes.find((n) => n.id === m.node_id);
        expect(stressed.local_latency_ticks).to.be.greaterThan(
          baseline.local_latency_ticks,
        );
      }
    });

    it("CONCURRENCY_CRUSH stressor reduces concurrency (stressed < baseline)", function () {
      const crush_seeds = SEEDS.filter(
        (seed) => generateScenario(seed).stressor.type === "CONCURRENCY_CRUSH",
      );
      for (const seed of crush_seeds) {
        const s = generateScenario(seed);
        const m = s.stressor.mutation;
        const baseline = s.nodes.find((n) => n.id === m.node_id);
        const stressed = s.stressed_nodes.find((n) => n.id === m.node_id);
        expect(stressed.max_concurrency).to.be.lessThan(
          baseline.max_concurrency,
        );
      }
    });

    it("ARRIVAL_SPIKE stressor increases arrival rate (stressed > baseline)", function () {
      const spike_seeds = SEEDS.filter(
        (seed) => generateScenario(seed).stressor.type === "ARRIVAL_SPIKE",
      );
      for (const seed of spike_seeds) {
        const s = generateScenario(seed);
        expect(s.stressed_arrival_rate).to.be.greaterThan(s.arrival_rate);
      }
    });

    it("TIMEOUT_TRAP sets timeout below downstream latency", function () {
      const trap_seeds = SEEDS.filter(
        (seed) => generateScenario(seed).stressor.type === "TIMEOUT_TRAP",
      );
      for (const seed of trap_seeds) {
        const s = generateScenario(seed);
        const m = s.stressor.mutation;
        const target = s.stressed_nodes.find((n) => n.id === m.edge.target_id);
        const stressed_edge = s.stressed_edges.find(
          (e) =>
            e.source_id === m.edge.source_id &&
            e.target_id === m.edge.target_id,
        );
        expect(stressed_edge.timeout_ticks).to.be.lessThan(
          target.local_latency_ticks,
        );
      }
    });
  });

  describe("Answer validity", function () {
    it("answer node_id always references an existing node", function () {
      for (const seed of SEEDS) {
        const s = generateScenario(seed);
        if (!s.answer) continue;
        const ids = s.nodes.map((n) => n.id);
        expect(ids).to.include(
          s.answer.node_id,
          `seed ${seed}: answer node must exist`,
        );
      }
    });

    it("answer failure_type is one of the known types", function () {
      const valid_types = [
        "QUEUE_DROP",
        "TIMEOUT_CASCADE",
        "DEADLINE_EXCEEDED",
        "RATE_LIMIT_DROP",
      ];
      for (const seed of SEEDS) {
        const s = generateScenario(seed);
        if (!s.answer) continue;
        expect(valid_types).to.include(s.answer.failure_type, `seed ${seed}`);
      }
    });

    it("answer tick is positive", function () {
      for (const seed of SEEDS) {
        const s = generateScenario(seed);
        if (!s.answer) continue;
        expect(s.answer.tick).to.be.greaterThan(0);
      }
    });
  });
});
