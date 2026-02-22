"use strict";

// ─── SyncAck ─────────────────────────────────────────────────────────────────
// Shared object between an upstream slot (waiting) and a downstream token
// (responsible for resolving). When the downstream slot releases, it sets
// ack.done = true, which frees the upstream SYNC wait.
class SyncAck {
  constructor() {
    this.done = false;
  }
}

// ─── Token ───────────────────────────────────────────────────────────────────
class Token {
  constructor(id, deadline, max_retries) {
    this.id = id;
    this.deadline_remaining = deadline; // Infinity = no deadline
    this.retry_count = 0;
    this.max_retries = max_retries;
    // Acks to resolve when this token's slot is released (signals upstream SYNC waiters)
    this.release_acks = [];
  }
}

// ─── Slot ────────────────────────────────────────────────────────────────────
// A concurrency slot occupied at a node. Can be in one of two sub-states:
//   - local processing (ticks_remaining > 0, sync_waits empty)
//   - waiting for SYNC responses (ticks_remaining === 0, sync_waits non-empty)
class Slot {
  constructor(token, ticks_remaining) {
    this.token = token;
    this.ticks_remaining = ticks_remaining;
    this.sync_waits = []; // [{ack, timeout_remaining, edge, done}]
  }

  get is_waiting_sync() {
    return this.sync_waits.length > 0 && this.sync_waits.some((sw) => !sw.done);
  }
}

// ─── NodeState ───────────────────────────────────────────────────────────────
class NodeState {
  constructor() {
    this.slots = []; // Slot[] — active concurrency slots
    this.queue = []; // Token[] — waiting to acquire a slot
  }
}

// ─── Simulator ───────────────────────────────────────────────────────────────
class Simulator {
  /**
   * @param {Object} cfg
   * @param {Array}  cfg.nodes          [{id, name, max_concurrency, queue_limit, local_latency_ticks}]
   * @param {Array}  cfg.edges          [{source_id, target_id, mode:'SYNC'|'ASYNC', timeout_ticks}]
   * @param {string} cfg.entry_node_id
   * @param {number} cfg.arrival_rate   tokens injected at entry per tick
   * @param {number} [cfg.deadline_ticks=0]  0 = no deadline
   * @param {number} [cfg.max_retries=0]     per-token SYNC retry budget
   */
  constructor(cfg) {
    this.nodes = Object.fromEntries(cfg.nodes.map((n) => [n.id, n]));
    this.edges = cfg.edges;
    this.entry_id = cfg.entry_node_id;
    this.arrival_rate = cfg.arrival_rate;
    this.deadline_ticks = cfg.deadline_ticks ?? 0;
    this.max_retries = cfg.max_retries ?? 0;

    this.state = Object.fromEntries(
      cfg.nodes.map((n) => [n.id, new NodeState()]),
    );

    // Token buckets: optional per-node rate limiting.
    // Each bucket starts full and refills by refill_rate per tick.
    this.buckets = {};
    for (const n of cfg.nodes) {
      if (n.token_bucket) {
        this.buckets[n.id] = {
          capacity: n.token_bucket.capacity,
          refill_rate: n.token_bucket.refill_rate,
          current: n.token_bucket.capacity,
        };
      }
    }

    this.tick_count = 0;
    this.next_token_id = 0;
    this.events = [];
    this.first_failure = null; // first terminal event: QUEUE_DROP, DEADLINE_EXCEEDED, or RATE_LIMIT_DROP
    this.first_timeout_cascade = null; // first TIMEOUT_CASCADE (non-terminal, for quiz use)
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  _edges_from(node_id) {
    return this.edges.filter((e) => e.source_id === node_id);
  }

  _log(type, node_id, token, detail) {
    const ev = {
      tick: this.tick_count,
      type,
      node_id,
      token_id: token.id,
      detail,
    };
    this.events.push(ev);
    if (type === "TIMEOUT_CASCADE") {
      if (!this.first_timeout_cascade) this.first_timeout_cascade = ev;
    } else {
      // QUEUE_DROP and DEADLINE_EXCEEDED are terminal — they stop the simulation.
      if (!this.first_failure) this.first_failure = ev;
    }
    return ev;
  }

  _promote(node_id) {
    const def = this.nodes[node_id];
    const ns = this.state[node_id];
    while (ns.queue.length && ns.slots.length < def.max_concurrency) {
      const token = ns.queue.shift();
      ns.slots.push(new Slot(token, def.local_latency_ticks));
    }
  }

  _inject(node_id, token) {
    const def = this.nodes[node_id];
    const ns = this.state[node_id];

    // Token bucket check: if the bucket is empty, reject immediately.
    // For SYNC callers, signal their ack right away (fast-fail, no slot held).
    if (this.buckets[node_id]) {
      const bucket = this.buckets[node_id];
      if (bucket.current < 1) {
        for (const ack of token.release_acks) ack.done = true;
        this._log(
          "RATE_LIMIT_DROP",
          node_id,
          token,
          `${def.name} quota bucket exhausted`,
        );
        return;
      }
      bucket.current -= 1;
    }

    if (ns.slots.length < def.max_concurrency) {
      ns.slots.push(new Slot(token, def.local_latency_ticks));
    } else if (ns.queue.length < def.queue_limit) {
      ns.queue.push(token);
    } else {
      this._log(
        "QUEUE_DROP",
        node_id,
        token,
        `${def.name} queue full (limit: ${def.queue_limit})`,
      );
    }
  }

  // Called when a slot is freed. Resolves all upstream SYNC acks this token was holding.
  _release_slot(node_id, slot) {
    for (const ack of slot.token.release_acks) ack.done = true;
    const ns = this.state[node_id];
    ns.slots = ns.slots.filter((s) => s !== slot);
    this._promote(node_id);
  }

  // Returns true if this token is a cache hit at a cache-subtype node.
  // Uses a deterministic hash of the token's numeric prefix so results are
  // reproducible across runs with the same seed.
  _cache_hit(node_id, token) {
    const def = this.nodes[node_id];
    if (def.node_subtype !== "cache" || def.hit_rate == null) return false;
    const num = parseInt(String(token.id).split(":")[0], 10);
    return (num % 1000) < def.hit_rate * 1000;
  }

  // Called when local processing finishes. Dispatches to downstream nodes.
  // Returns true if slot should be released immediately (no SYNC waits added).
  _dispatch(slot, node_id) {
    // Cache hit: serve from memory, skip all downstream edges.
    if (this._cache_hit(node_id, slot.token)) {
      return true;
    }

    const out = this._edges_from(node_id);
    if (out.length === 0) return true; // exit node

    let has_sync = false;

    for (const edge of out) {
      // For fan-out: each branch gets its own Token instance (same deadline budget).
      const t = new Token(
        `${slot.token.id}:${edge.target_id}`,
        slot.token.deadline_remaining,
        slot.token.max_retries,
      );

      if (edge.mode === "ASYNC") {
        this._inject(edge.target_id, t);
        // Slot released immediately — no hold.
      } else {
        // SYNC: create ack, hold slot until downstream resolves it.
        const ack = new SyncAck();
        t.release_acks.push(ack);
        if (!edge.partitioned) {
          // Partitioned edges black-hole the token: ack never resolves until
          // timeout fires, then TIMEOUT_CASCADE runs the normal path.
          this._inject(edge.target_id, t);
        }
        slot.sync_waits.push({
          ack,
          timeout_remaining: edge.timeout_ticks,
          edge,
          done: false,
        });
        has_sync = true;
      }
    }

    return !has_sync;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  tick() {
    this.tick_count++;

    // 0. Refill token buckets before processing arrivals.
    for (const bucket of Object.values(this.buckets)) {
      bucket.current = Math.min(
        bucket.capacity,
        bucket.current + bucket.refill_rate,
      );
    }

    // 1. Inject new arrivals at entry node.
    for (let i = 0; i < this.arrival_rate; i++) {
      const deadline = this.deadline_ticks > 0 ? this.deadline_ticks : Infinity;
      const t = new Token(this.next_token_id++, deadline, this.max_retries);
      this._inject(this.entry_id, t);
    }

    // 2. Advance every node.
    for (const node_id of Object.keys(this.state)) {
      const ns = this.state[node_id];
      const to_release = [];

      // Expire queued tokens whose deadlines have run out.
      if (this.deadline_ticks > 0) {
        const keep = [];
        for (const token of ns.queue) {
          token.deadline_remaining--;
          if (token.deadline_remaining <= 0) {
            this._log(
              "DEADLINE_EXCEEDED",
              node_id,
              token,
              `Deadline expired in queue at ${this.nodes[node_id].name}`,
            );
          } else {
            keep.push(token);
          }
        }
        ns.queue = keep;
      }

      for (const slot of [...ns.slots]) {
        // snapshot to avoid mutation during iteration
        // Tick deadline.
        if (slot.token.deadline_remaining !== Infinity) {
          slot.token.deadline_remaining--;
          if (slot.token.deadline_remaining <= 0) {
            this._log(
              "DEADLINE_EXCEEDED",
              node_id,
              slot.token,
              `Deadline exhausted at ${this.nodes[node_id].name}`,
            );
            to_release.push(slot);
            continue;
          }
        }

        if (slot.is_waiting_sync) {
          // Advance sync timeouts.
          for (const sw of slot.sync_waits) {
            if (sw.done) continue;
            if (sw.ack.done) {
              sw.done = true;
              continue;
            } // resolved by downstream

            sw.timeout_remaining--;
            if (sw.timeout_remaining <= 0) {
              this._log(
                "TIMEOUT_CASCADE",
                node_id,
                slot.token,
                `SYNC call to ${this.nodes[sw.edge.target_id].name} timed out`,
              );

              if (
                slot.token.retry_count < slot.token.max_retries &&
                slot.token.deadline_remaining > 0
              ) {
                // Exponential backoff: each retry doubles the wait before
                // the next attempt (2^n × original timeout). The upstream
                // slot is held throughout, amplifying backpressure.
                slot.token.retry_count++;
                sw.timeout_remaining =
                  sw.edge.timeout_ticks * Math.pow(2, slot.token.retry_count);
              } else if (this.max_retries > 0 || this.deadline_ticks > 0) {
                // A retry budget or wall-clock deadline was configured and is
                // now exhausted — this is a true DEADLINE_EXCEEDED.
                this._log(
                  "DEADLINE_EXCEEDED",
                  node_id,
                  slot.token,
                  `Retries/deadline exhausted on SYNC to ${this.nodes[sw.edge.target_id].name}`,
                );
                sw.done = true;
              } else {
                // No retry policy at all — SYNC timeout simply releases the
                // slot (TIMEOUT_CASCADE already logged above). The system
                // keeps running; queue pressure determines the terminal event.
                sw.done = true;
              }
            }
          }

          if (slot.sync_waits.every((sw) => sw.done)) {
            to_release.push(slot);
          }
        } else {
          // Local processing countdown.
          slot.ticks_remaining--;
          if (slot.ticks_remaining <= 0) {
            const release_now = this._dispatch(slot, node_id);
            if (release_now) to_release.push(slot);
          }
        }
      }

      for (const slot of to_release) {
        this._release_slot(node_id, slot);
      }
    }

    return this.first_failure;
  }

  /**
   * Run until first failure or max_ticks.
   * @returns {{failure, ticks_run, events, node_peaks}}
   */
  run(max_ticks = 500) {
    // Track peak queue depths per node for diagnostics.
    const peaks = Object.fromEntries(
      Object.keys(this.state).map((id) => [id, 0]),
    );

    while (this.tick_count < max_ticks && !this.first_failure) {
      this.tick();
      for (const [id, ns] of Object.entries(this.state)) {
        peaks[id] = Math.max(peaks[id], ns.queue.length);
      }
    }

    return {
      failure: this.first_failure,
      first_timeout_cascade: this.first_timeout_cascade,
      ticks_run: this.tick_count,
      events: this.events,
      node_peaks: peaks,
    };
  }
}
