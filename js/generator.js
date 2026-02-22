"use strict";

// ─── Seeded RNG (Mulberry32) ─────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randInt(rng, lo, hi) {
  return lo + Math.floor(rng() * (hi - lo + 1));
}
function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// ─── Name pools ──────────────────────────────────────────────────────────────
const ENTRY_NAMES = [
  "Ingress API",
  "API Gateway",
  "Web Frontend",
  "Load Balancer",
];
const MIDDLE_NAMES = [
  "Auth Service",
  "User Service",
  "Cache Layer",
  "Session Store",
  "Search Service",
  "Payment Service",
  "Notification Service",
  "Config Service",
  "Token Validator",
  "Inventory Service",
  "Order Service",
  "Rate Limiter",
  "Recommendation Engine",
  "Billing Service",
];
const EXIT_NAMES = [
  "Primary DB",
  "Query Cache",
  "Message Queue",
  "Blob Storage",
  "Analytics Sink",
  "Event Store",
];

// ─── Topologies ──────────────────────────────────────────────────────────────
// Each entry is an array of layer sizes. Layer 0 is always entry, last is always exit.
const TOPOLOGIES_COMMON = [
  [1, 1, 1], // linear 3-node
  [1, 1, 1, 1], // linear 4-node
  [1, 2, 1], // diamond (fork then join)
  [1, 1, 2, 1], // 5-node: fan-out at end
  [1, 2, 1, 1], // 5-node: fan-in at start
];
const TOPOLOGIES_RARE = [
  [1, 1, 1, 1, 1], // linear 5-node: deep SYNC chains
  [1, 3, 1], // triple fan-out/in: 3× load at exit
  [1, 2, 2, 1], // double-wide: cross-edges between both middle layers
];

// ─── Cache node name pools ────────────────────────────────────────────────────
const CACHE_NAMES = [
  "Product Cache",
  "Query Cache",
  "Redis Cache",
  "Memcache Layer",
  "L2 Cache",
];
const DB_NAMES = [
  "Primary DB",
  "Postgres",
  "MySQL Cluster",
  "Read Replica",
  "Datastore",
];

// ─── Graph builder ───────────────────────────────────────────────────────────
function buildTopology(rng) {
  // 15% chance of a dedicated cache–db topology (4-node linear, last two nodes
  // are cache + db). The cache absorbs most traffic under baseline; CACHE_FLUSH
  // stressor drops hit_rate to 0 and exposes the unprotected DB.
  const use_cache_db = rng() < 0.15;
  let template;
  if (use_cache_db) {
    template = [1, 1, 1, 1];
  } else {
    const pool = rng() < 0.2 ? TOPOLOGIES_RARE : TOPOLOGIES_COMMON;
    template = pick(rng, pool);
  }

  const layers = [];
  let node_num = 0;

  for (let li = 0; li < template.length; li++) {
    const layer = [];
    const size = template[li];
    for (let i = 0; i < size; i++) {
      let name;
      if (li === 0) name = pick(rng, ENTRY_NAMES);
      else if (li === template.length - 1) name = pick(rng, EXIT_NAMES);
      else name = pick(rng, MIDDLE_NAMES);

      // Base capacities: designed to be stable under a moderate arrival rate.
      const max_concurrency = randInt(rng, 3, 8);
      const local_latency_ticks = randInt(rng, 2, 6);
      const queue_limit = randInt(rng, 8, 20);

      layer.push({
        id: `n${node_num++}`,
        name,
        max_concurrency,
        queue_limit,
        local_latency_ticks,
      });
    }
    layers.push(layer);
  }

  const nodes = layers.flat();
  const edges = [];

  // Connect each node in layer i to every node in layer i+1.
  for (let li = 0; li < layers.length - 1; li++) {
    for (const src of layers[li]) {
      for (const tgt of layers[li + 1]) {
        // Entry edges are less likely to be SYNC so arrival spikes can propagate
        // to downstream nodes rather than always backing up at the entry node.
        const sync_prob = li === 0 ? 0.4 : 0.65;
        const mode = rng() < sync_prob ? "SYNC" : "ASYNC";
        // Baseline timeout: generous (won't fire under normal conditions).
        const timeout_ticks = tgt.local_latency_ticks * 6 + randInt(rng, 5, 15);
        edges.push({
          source_id: src.id,
          target_id: tgt.id,
          mode,
          timeout_ticks,
        });
      }
    }
  }

  // Post-process cache–db topology: override the last two nodes with cache/db
  // specific properties and force the cache→DB edge to SYNC.
  if (use_cache_db) {
    const cache_node = layers[layers.length - 2][0];
    const db_node = layers[layers.length - 1][0];

    cache_node.node_subtype = "cache";
    cache_node.hit_rate = randInt(rng, 75, 92) / 100;
    cache_node.local_latency_ticks = 1; // cache lookup is fast
    cache_node.max_concurrency = randInt(rng, 15, 25);
    cache_node.name = pick(rng, CACHE_NAMES);
    // Queue must comfortably fit burst traffic; don't let the cache itself be the bottleneck.
    cache_node.queue_limit = Math.max(cache_node.queue_limit, 30);

    db_node.max_concurrency = randInt(rng, 3, 6); // DB is slow, limited concurrency
    db_node.local_latency_ticks = randInt(rng, 8, 16); // DB is expensive
    db_node.queue_limit = randInt(rng, 10, 18);
    db_node.name = pick(rng, DB_NAMES);

    // Cache→DB edge must be SYNC: the cache caller waits for the DB response.
    const cache_db_edge = edges.find(
      (e) => e.source_id === cache_node.id && e.target_id === db_node.id,
    );
    if (cache_db_edge) {
      cache_db_edge.mode = "SYNC";
      // Recalculate timeout now that we know db latency.
      cache_db_edge.timeout_ticks =
        db_node.local_latency_ticks * 6 + randInt(rng, 5, 15);
    }
  }

  return { nodes, edges, layers, entry_node_id: nodes[0].id };
}

// ─── Stability analysis ──────────────────────────────────────────────────────
// For SYNC edges, the upstream node holds its concurrency slot for the entire
// downstream processing time. The effective slot time for a node is therefore:
//   own latency + max(effective slot time of SYNC children)
function effectiveSlotTime(node_id, nodes_map, edges) {
  const node = nodes_map[node_id];
  const sync_kids = edges.filter(
    (e) => e.source_id === node_id && e.mode === "SYNC",
  );
  if (!sync_kids.length) return node.local_latency_ticks;
  const max_child = Math.max(
    ...sync_kids.map((e) => effectiveSlotTime(e.target_id, nodes_map, edges)),
  );
  return node.local_latency_ticks + max_child;
}

// Compute how many tokens per entry-arrival reach each node (fan-in multiplier).
// In a diamond [1,2,1] with both branches active, the exit node receives 2 tokens
// per entry arrival. Without accounting for this, the exit node's throughput is
// overestimated and the system is more fragile than the formula predicts.
function computeLoadFactors(nodes, edges, entry_id) {
  const factors = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  const nodes_map = Object.fromEntries(nodes.map((n) => [n.id, n]));
  factors[entry_id] = 1;
  // Kahn's algorithm ensures we process each node after all its predecessors.
  const in_deg = Object.fromEntries(nodes.map((n) => [n.id, 0]));
  for (const e of edges) in_deg[e.target_id]++;
  const q = nodes.filter((n) => in_deg[n.id] === 0).map((n) => n.id);
  while (q.length) {
    const id = q.shift();
    const def = nodes_map[id];
    // Cache nodes only forward (1 - hit_rate) of their traffic downstream.
    // Under baseline hit rate this keeps the DB at a fraction of total load.
    const forwarding =
      def.node_subtype === "cache" ? 1 - (def.hit_rate ?? 0) : 1;
    for (const e of edges.filter((e) => e.source_id === id)) {
      factors[e.target_id] += factors[id] * forwarding;
      if (--in_deg[e.target_id] === 0) q.push(e.target_id);
    }
  }
  return factors;
}

function safeArrivalRate(nodes, edges, entry_id) {
  const nodes_map = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const load_factors = computeLoadFactors(nodes, edges, entry_id);
  const min_tp = Math.min(
    ...nodes.map((n) => {
      const slot_time = effectiveSlotTime(n.id, nodes_map, edges);
      const load = load_factors[n.id] || 1;
      // Normalised: tokens this node can sustain per entry-arrival tick
      return n.max_concurrency / slot_time / load;
    }),
  );
  return Math.max(1, Math.floor(min_tp * 0.55));
}

// ─── Stressor definitions ────────────────────────────────────────────────────
const STRESSOR_TYPES = [
  "LATENCY_SPIKE",
  "CONCURRENCY_CRUSH",
  "ARRIVAL_SPIKE",
  "TIMEOUT_TRAP",
  "QUOTA_IDENTITY_BUG",
  "NETWORK_PARTITION",
  "CACHE_FLUSH",
  "AGGRESSIVE_RETRIES",
];

function applyStressor(rng, nodes, edges, arrival_rate, forced_type) {
  // Deep-clone so we can return both baseline and stressed configs.
  // token_bucket is an object — needs its own shallow clone.
  nodes = nodes.map((n) => ({
    ...n,
    token_bucket: n.token_bucket ? { ...n.token_bucket } : undefined,
  }));
  edges = edges.map((e) => ({ ...e }));

  // QUOTA_IDENTITY_BUG requires at least one bucketed node.
  // NETWORK_PARTITION requires at least one SYNC edge.
  // CACHE_FLUSH requires at least one cache-subtype node.
  const bucketed = nodes.filter((n) => n.token_bucket);
  const sync_edges = edges.filter((e) => e.mode === "SYNC");
  const cache_nodes = nodes.filter((n) => n.node_subtype === "cache");
  const available = STRESSOR_TYPES.filter((t) => {
    if (t === "QUOTA_IDENTITY_BUG") return bucketed.length > 0;
    if (t === "NETWORK_PARTITION") return sync_edges.length > 0;
    if (t === "CACHE_FLUSH") return cache_nodes.length > 0;
    if (t === "AGGRESSIVE_RETRIES") return sync_edges.length > 0;
    return true;
  });
  const type = forced_type ?? pick(rng, available);

  // If a specific type was forced but can't be applied, signal that.
  if (type === "QUOTA_IDENTITY_BUG" && bucketed.length === 0) return null;
  if (type === "NETWORK_PARTITION" && sync_edges.length === 0) return null;
  if (type === "CACHE_FLUSH" && cache_nodes.length === 0) return null;
  if (type === "AGGRESSIVE_RETRIES" && sync_edges.length === 0) return null;
  let description, mutation;

  if (type === "LATENCY_SPIKE") {
    // Pick a non-entry node that is reached by at least one SYNC edge.
    // The interesting failure manifests upstream of this node.
    const sync_targets = new Set(
      edges.filter((e) => e.mode === "SYNC").map((e) => e.target_id),
    );
    const candidates = nodes.filter(
      (n) => n.id !== nodes[0].id && sync_targets.has(n.id),
    );
    const target = candidates.length
      ? pick(rng, candidates)
      : nodes[nodes.length - 1];
    const mult = randInt(rng, 6, 10);
    const old_v = target.local_latency_ticks;
    const new_v = old_v * mult;
    nodes.find((n) => n.id === target.id).local_latency_ticks = new_v;
    description =
      `${target.name} is experiencing severe I/O degradation. ` +
      `Processing time: ${old_v} → ${new_v} ticks (${mult}×).`;
    mutation = {
      type,
      node_id: target.id,
      property: "local_latency_ticks",
      old_value: old_v,
      new_value: new_v,
    };
  } else if (type === "CONCURRENCY_CRUSH") {
    // Pick any non-entry node and aggressively reduce its concurrency.
    const target = pick(rng, nodes.slice(1));
    const old_v = target.max_concurrency;
    const new_v = Math.max(1, Math.floor(old_v / 3));
    nodes.find((n) => n.id === target.id).max_concurrency = new_v;
    description =
      `${target.name} is under severe memory pressure. ` +
      `Max concurrency: ${old_v} → ${new_v} (thread pool starved).`;
    mutation = {
      type,
      node_id: target.id,
      property: "max_concurrency",
      old_value: old_v,
      new_value: new_v,
    };
  } else if (type === "ARRIVAL_SPIKE") {
    const mult = randInt(rng, 3, 5);
    const old_v = arrival_rate;
    const new_v = old_v * mult;
    arrival_rate = new_v;
    description = `Thundering herd event. Arrival rate: ${old_v} → ${new_v} requests/tick (${mult}×).`;
    mutation = {
      type,
      property: "arrival_rate",
      old_value: old_v,
      new_value: new_v,
    };
  } else if (type === "TIMEOUT_TRAP") {
    // Pick a SYNC edge and set its timeout below the target's processing time.
    const sync_edges = edges.filter((e) => e.mode === "SYNC");
    const edge = sync_edges.length ? pick(rng, sync_edges) : edges[0];
    const target_node = nodes.find((n) => n.id === edge.target_id);
    const old_v = edge.timeout_ticks;
    // Set timeout to well below downstream latency — guaranteed to fire.
    const new_v = Math.max(
      1,
      Math.floor(target_node.local_latency_ticks * 0.4),
    );
    edges.find(
      (e) => e.source_id === edge.source_id && e.target_id === edge.target_id,
    ).timeout_ticks = new_v;
    const src_name = nodes.find((n) => n.id === edge.source_id).name;
    description =
      `Misconfigured timeout on ${src_name} → ${target_node.name}. ` +
      `timeout_ticks: ${old_v} → ${new_v} (well below downstream latency of ${target_node.local_latency_ticks}).`;
    mutation = {
      type,
      edge,
      property: "timeout_ticks",
      old_value: old_v,
      new_value: new_v,
    };
  } else if (type === "NETWORK_PARTITION") {
    // Sever a SYNC edge silently: tokens sent across it are black-holed.
    // The upstream caller cannot distinguish this from an infinitely slow response
    // and waits the full timeout_ticks on every call, tying up its concurrency slots.
    const edge = pick(rng, sync_edges);
    const src_name = nodes.find((n) => n.id === edge.source_id).name;
    const tgt_name = nodes.find((n) => n.id === edge.target_id).name;
    edges.find(
      (e) => e.source_id === edge.source_id && e.target_id === edge.target_id,
    ).partitioned = true;
    description =
      `Network partition between ${src_name} and ${tgt_name}. ` +
      `Packets are silently dropped — no TCP RST, no error response. ` +
      `${src_name} cannot distinguish this from an infinitely slow downstream ` +
      `and waits the full ${edge.timeout_ticks}-tick timeout on every SYNC call.`;
    mutation = {
      type,
      edge,
      property: "partitioned",
      old_value: false,
      new_value: true,
    };
  } else if (type === "CACHE_FLUSH") {
    // Drop the cache's hit rate to zero — every token now punches through to the DB.
    // The global arrival rate is unchanged; the thundering herd is internal to the system.
    const target = pick(rng, cache_nodes);
    const old_hr = target.hit_rate;
    nodes.find((n) => n.id === target.id).hit_rate = 0;
    description =
      `${target.name} experienced a full cache flush (TTL expiry or invalidation storm). ` +
      `Hit rate: ${Math.round(old_hr * 100)}% → 0%. ` +
      `Every request now reaches the database cold.`;
    mutation = {
      type,
      node_id: target.id,
      property: "hit_rate",
      old_value: old_hr,
      new_value: 0,
    };
  } else if (type === "AGGRESSIVE_RETRIES") {
    // Pick a SYNC edge. Set its timeout well below the target's processing
    // latency so it fires on every call. Zero-backoff retries (max_retries: 3)
    // flood the downstream without holding the upstream slot.
    const ar_sync_edges = edges.filter((e) => e.mode === "SYNC");
    const edge = pick(rng, ar_sync_edges);
    const target_node = nodes.find((n) => n.id === edge.target_id);
    const old_v = edge.timeout_ticks;
    const new_v = Math.max(
      1,
      Math.floor(target_node.local_latency_ticks * 0.4),
    );
    edges.find(
      (e) => e.source_id === edge.source_id && e.target_id === edge.target_id,
    ).timeout_ticks = new_v;
    const src_name = nodes.find((n) => n.id === edge.source_id).name;
    description =
      `${src_name} is misconfigured with zero-backoff retries and a tight timeout ` +
      `of ${new_v} ticks (downstream latency: ${target_node.local_latency_ticks} ticks). ` +
      `Every timed-out call immediately fires a fresh retry without waiting, ` +
      `multiplying load on ${target_node.name} up to 4×.`;
    mutation = {
      type,
      edge,
      property: "timeout_ticks",
      old_value: old_v,
      new_value: new_v,
      max_retries: 3,
    };
  } else {
    // QUOTA_IDENTITY_BUG
    // Collapse a node's generous per-caller bucket into a tiny shared-identity bucket.
    const target = pick(rng, bucketed);
    const old_tb = target.token_bucket;
    const new_cap = Math.max(1, Math.floor(old_tb.capacity * 0.1));
    const new_ref = Math.max(1, Math.floor(old_tb.refill_rate * 0.15));
    nodes.find((n) => n.id === target.id).token_bucket = {
      capacity: new_cap,
      refill_rate: new_ref,
    };
    description =
      `${target.name} is forwarding its own service identity instead of the caller's. ` +
      `All traffic now draws from one shared quota bucket ` +
      `(capacity: ${old_tb.capacity}→${new_cap}, refill: ${old_tb.refill_rate}→${new_ref}/tick).`;
    mutation = {
      type,
      node_id: target.id,
      property: "token_bucket",
      old_value: old_tb,
      new_value: { capacity: new_cap, refill_rate: new_ref },
    };
  }

  return {
    stressed_nodes: nodes,
    stressed_edges: edges,
    stressed_arrival_rate: arrival_rate,
    stressor: { type, description, mutation },
  };
}

// ─── Causal explanation builder ──────────────────────────────────────────────
function buildExplanation(failure, events, nodes_map, stressor) {
  if (!failure)
    return "The system remained stable for the entire simulation window.";

  const failed_node = nodes_map[failure.node_id]?.name ?? failure.node_id;

  if (failure.type === "TIMEOUT_CASCADE") {
    return `Every SYNC call from ${failed_node} timed out immediately — the configured timeout is shorter than the downstream node's processing time. Upstream slots stay locked on every attempt, causing a permanent stall.`;
  }

  if (failure.type === "RATE_LIMIT_DROP") {
    if (stressor.type === "QUOTA_IDENTITY_BUG") {
      return (
        `${failed_node} was forwarding all requests under its own service identity instead of propagating the caller's. ` +
        `Every request drew from a single shared quota bucket rather than per-caller buckets, exhausting it almost immediately under normal load.`
      );
    }
    return (
      `${failed_node}'s quota bucket was drained faster than it could refill under the traffic surge. ` +
      `Requests were immediately rejected once the bucket hit zero — no queuing, instant drop.`
    );
  }

  if (failure.type === "DEADLINE_EXCEEDED") {
    return `Every SYNC call from ${failed_node} timed out. With exponential backoff each retry doubled the wait (T → 2T → 4T ticks), holding the upstream concurrency slot for the full 7T duration before the retry budget was exhausted. Prolonged slot occupancy starved other requests of capacity.`;
  }

  // QUEUE_DROP
  const prior_timeouts = events.filter(
    (e) => e.type === "TIMEOUT_CASCADE" && e.tick < failure.tick,
  );
  if (
    stressor.type === "LATENCY_SPIKE" ||
    stressor.type === "CONCURRENCY_CRUSH"
  ) {
    return prior_timeouts.length
      ? `The degraded downstream node held upstream SYNC slots for far longer than usual, preventing ${failed_node} from accepting new requests until its queue was exhausted.`
      : `Reduced throughput at the bottleneck caused ${failed_node}'s queue to fill faster than it could drain under the sustained load.`;
  }
  if (stressor.type === "ARRIVAL_SPIKE") {
    return `The ${stressor.mutation.new_value / stressor.mutation.old_value}× surge in traffic exceeded the system's sustainable capacity. ${failed_node} hit its queue limit first because it is the tightest bottleneck in the path.`;
  }
  if (stressor.type === "TIMEOUT_TRAP") {
    return `After repeated SYNC timeouts, ${failed_node}'s queue filled with requests that could not complete — each held an upstream slot and blocked further progress until the buffer was exhausted.`;
  }

  if (stressor.type === "NETWORK_PARTITION") {
    const tgt_name =
      nodes_map[stressor.mutation.edge.target_id]?.name ??
      stressor.mutation.edge.target_id;
    return (
      `${tgt_name} became unreachable — all packets on the link were silently dropped with no error response. ` +
      `${failed_node} had no way to distinguish a partition from an infinitely slow downstream ` +
      `and waited the full ${stressor.mutation.edge.timeout_ticks} ticks on every SYNC call. ` +
      `With all concurrency slots occupied by calls that would never complete, ` +
      `${failed_node}'s queue filled and began dropping requests.`
    );
  }

  if (stressor.type === "AGGRESSIVE_RETRIES") {
    const mult = stressor.mutation.max_retries + 1;
    return (
      `Each of ${failed_node}'s callers timed out and immediately fired a fresh retry without waiting. ` +
      `With ${stressor.mutation.max_retries} retries per call and zero backoff, ` +
      `each original request generated up to ${mult}× the downstream traffic. ` +
      `This ${mult}× amplification overwhelmed ${failed_node}'s queue within ${failure.tick} ticks ` +
      `despite the entry arrival rate being unchanged.`
    );
  }

  if (stressor.type === "CACHE_FLUSH") {
    const db_node = nodes_map[failure.node_id];
    return (
      `${failed_node} was previously shielded by the cache absorbing ` +
      `${Math.round(stressor.mutation.old_value * 100)}% of traffic. ` +
      `With the cache flushed, 100% of requests hit the database simultaneously — ` +
      `a classic thundering herd. ` +
      `The DB's concurrency limit (${db_node?.max_concurrency ?? "?"} slots) ` +
      `was overwhelmed and its queue filled in ${failure.tick} ticks.`
    );
  }

  return failure.detail;
}

// ─── Main entry point ─────────────────────────────────────────────────────────
/**
 * Generate a complete scenario object ready to display and evaluate.
 * @param {number} [seed] - optional seed for reproducibility
 * @returns {Scenario}
 */
function generateScenario(seed) {
  seed = seed ?? Date.now() & 0xffffffff;
  const rng = mulberry32(seed);

  // 1. Build baseline topology.
  const { nodes, edges, layers, entry_node_id } = buildTopology(rng);
  let arrival_rate = safeArrivalRate(nodes, edges, entry_node_id);

  // Formula can still underestimate due to queueing dynamics. Verify and correct.
  // If even rate=1 is unstable (can happen with very long SYNC chains and low
  // random concurrencies), boost the tightest bottleneck nodes instead of producing
  // an unfixable scenario.
  (function verifyAndAdjust() {
    while (arrival_rate >= 1) {
      const check = new Simulator({
        nodes,
        edges,
        entry_node_id,
        arrival_rate,
        deadline_ticks: 0,
        max_retries: 0,
      });
      if (!check.run(400).failure) return; // stable
      arrival_rate--;
    }
    // Rate < 1 means even 1 token/tick overloads the system.
    // Boost concurrencies on the bottleneck nodes to restore stability.
    arrival_rate = 1;
    const nm = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const lf = computeLoadFactors(nodes, edges, entry_node_id);
    for (const node of nodes) {
      const est = effectiveSlotTime(node.id, nm, edges);
      const min_conc = Math.ceil(lf[node.id] * est * 1.5);
      if (node.max_concurrency < min_conc) node.max_concurrency = min_conc;
    }
  })();

  // 2. Assign optional token buckets to non-entry nodes.
  // Done after verifyAndAdjust so we know the stable arrival_rate.
  // Refill rate is set to 2–3× the effective per-node arrival rate so the
  // baseline is always stable; ARRIVAL_SPIKE (3–5×) can exhaust it.
  (function assignBuckets() {
    const lf = computeLoadFactors(nodes, edges, entry_node_id);
    for (const node of nodes.slice(1)) {
      // skip entry; cache nodes don't need token buckets (hit_rate is the filter)
      if (node.node_subtype === "cache") continue;
      if (rng() < 0.35) {
        const effective = arrival_rate * (lf[node.id] || 1);
        const headroom = randInt(rng, 2, 3);
        const refill_rate = Math.max(2, Math.ceil(effective * headroom));
        const capacity = refill_rate * randInt(rng, 8, 12);
        node.token_bucket = { capacity, refill_rate };
      }
    }
  })();

  // 3. Apply stressor and verify it causes failure within 600 ticks.
  // If the first randomly chosen stressor leaves the system stable (e.g. CONCURRENCY_CRUSH
  // on a node with comfortable headroom), cycle through the remaining types until one works.
  function runStressor(forced_type) {
    const applied = applyStressor(rng, nodes, edges, arrival_rate, forced_type);
    if (!applied) return null; // stressor not applicable (e.g. QUOTA_IDENTITY_BUG with no buckets)

    // TIMEOUT_TRAP: exponential backoff, slot held throughout → DEADLINE_EXCEEDED.
    // AGGRESSIVE_RETRIES: immediate retry, slot released → downstream QUEUE_DROP.
    // Other stressors: no retries.
    const max_retries =
      applied.stressor.type === "TIMEOUT_TRAP"
        ? 2
        : applied.stressor.type === "AGGRESSIVE_RETRIES"
          ? 3
          : 0;
    const retry_mode =
      applied.stressor.type === "TIMEOUT_TRAP"
        ? "exponential"
        : applied.stressor.type === "AGGRESSIVE_RETRIES"
          ? "immediate"
          : "none";
    const deadline_ticks = 0; // retry-count budget only, no wall-clock deadline

    const sim = new Simulator({
      nodes: applied.stressed_nodes,
      edges: applied.stressed_edges,
      entry_node_id,
      arrival_rate: applied.stressed_arrival_rate,
      deadline_ticks,
      max_retries,
      retry_mode,
    });
    const r = sim.run(600);
    // Prefer the terminal failure (DEADLINE_EXCEEDED or QUEUE_DROP) as the quiz
    // answer. Fall back to first_timeout_cascade only if no terminal event fired.
    const qe = r.failure ?? r.first_timeout_cascade;
    return {
      ...applied,
      result: r,
      quiz_event: qe,
      max_retries,
      retry_mode,
      deadline_ticks,
    };
  }

  let best = runStressor(undefined); // random pick first
  if (!best || !best.quiz_event) {
    for (const t of STRESSOR_TYPES) {
      if (best && t === best.stressor.type) continue;
      const attempt = runStressor(t);
      if (attempt && attempt.quiz_event) {
        best = attempt;
        break;
      }
    }
  }

  const {
    stressed_nodes,
    stressed_edges,
    stressed_arrival_rate,
    stressor,
    result,
    quiz_event,
    max_retries,
    retry_mode,
    deadline_ticks,
  } = best;
  const nodes_map = Object.fromEntries(stressed_nodes.map((n) => [n.id, n]));

  const explanation = quiz_event
    ? buildExplanation(quiz_event, result.events, nodes_map, stressor)
    : "The system held stable. Try a different stressor.";

  return {
    seed,
    // Baseline (for display)
    nodes,
    edges,
    layers,
    entry_node_id,
    arrival_rate,
    // Stressor
    stressor,
    // Retry / deadline policy active for this scenario
    max_retries,
    retry_mode,
    deadline_ticks,
    // Stressed config (for reference / replay)
    stressed_nodes,
    stressed_edges,
    stressed_arrival_rate,
    // Answer (hidden from user until they guess)
    answer: quiz_event
      ? {
          node_id: quiz_event.node_id,
          failure_type: quiz_event.type,
          tick: quiz_event.tick,
          explanation,
          node_peaks: result.node_peaks,
        }
      : null,
  };
}
