"use strict";

// ─── SVG helpers ─────────────────────────────────────────────────────────────
const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}
function svgText(text, attrs = {}) {
  const el = svgEl("text", attrs);
  el.textContent = text;
  return el;
}

// ─── Layout constants ─────────────────────────────────────────────────────────
const NODE_W = 140;
const NODE_H = 96;
const PAD_X = 60; // horizontal padding from canvas edge
const PAD_Y = 50;
const LAYER_GAP = 200; // horizontal gap between layer centres
const NODE_GAP = 126; // vertical gap between nodes in the same layer

// ─── Layout computation ───────────────────────────────────────────────────────
function computeLayout(layers) {
  const positions = {};
  const max_in_layer = Math.max(...layers.map((l) => l.length));
  const canvas_h = PAD_Y * 2 + NODE_H + (max_in_layer - 1) * NODE_GAP;

  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li];
    const cx = PAD_X + li * LAYER_GAP + NODE_W / 2;
    const span = (layer.length - 1) * NODE_GAP;
    const start_y = (canvas_h - span - NODE_H) / 2; // vertically centred

    for (let ni = 0; ni < layer.length; ni++) {
      positions[layer[ni].id] = {
        x: cx - NODE_W / 2,
        y: start_y + ni * NODE_GAP,
        cx,
        cy: start_y + ni * NODE_GAP + NODE_H / 2,
      };
    }
  }

  return positions;
}

function canvasSize(layers) {
  const max_in_layer = Math.max(...layers.map((l) => l.length));
  const w = PAD_X * 2 + (layers.length - 1) * LAYER_GAP + NODE_W;
  const h = PAD_Y * 2 + NODE_H + (max_in_layer - 1) * NODE_GAP;
  return { w, h };
}

// ─── Graph renderer ───────────────────────────────────────────────────────────
class GraphRenderer {
  /**
   * @param {HTMLElement} container  Element that will hold the SVG.
   * @param {Function}    on_node_click  Called with node_id when a node is clicked.
   */
  constructor(container, on_node_click) {
    this.container = container;
    this.on_node_click = on_node_click;
    this.selected_id = null;
    this.answer_id = null;
    this.svg = null;
    this._node_els = {};
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  render(scenario) {
    this.scenario = scenario;
    this.selected_id = null;
    this.answer_id = null;
    this._node_els = {};
    this.container.innerHTML = "";

    const {
      stressed_nodes: nodes,
      stressed_edges: edges,
      layers,
      stressor,
    } = scenario;
    const pos = computeLayout(layers);
    const { w, h } = canvasSize(layers);

    const svg = svgEl("svg", {
      viewBox: `0 0 ${w} ${h}`,
      width: "100%",
      class: "graph-svg",
    });
    this.svg = svg;

    // Defs: arrowhead markers.
    const defs = svgEl("defs");
    defs.innerHTML = `
      <marker id="arrow-sync"  markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="var(--sync-color)" />
      </marker>
      <marker id="arrow-async" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="var(--async-color)" />
      </marker>
      <marker id="arrow-stress" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="var(--stress-color)" />
      </marker>
    `;
    svg.appendChild(defs);

    // Edge paths first (drawn under nodes), labels collected for later.
    const stressed_edge = stressor.mutation.edge ?? null;
    const stressed_node_id = stressor.mutation.node_id ?? null;

    const label_groups = [];
    for (const edge of edges) {
      const from = pos[edge.source_id];
      const to = pos[edge.target_id];
      const is_stressed =
        stressed_edge &&
        stressed_edge.source_id === edge.source_id &&
        stressed_edge.target_id === edge.target_id;

      label_groups.push(this._drawEdge(svg, from, to, edge, is_stressed));
    }

    // Nodes.
    for (const node of nodes) {
      const p = pos[node.id];
      const is_stressed = node.id === stressed_node_id;
      const el = this._drawNode(svg, node, p, is_stressed);
      this._node_els[node.id] = el;

      el.addEventListener("click", () => {
        this.on_node_click(node.id);
      });
    }

    // Edge labels on top of everything.
    for (const lbl of label_groups) svg.appendChild(lbl);

    this.container.appendChild(svg);
  }

  selectNode(node_id) {
    // Clear previous selection.
    for (const [id, el] of Object.entries(this._node_els)) {
      el.classList.remove("node--selected");
    }
    this.selected_id = node_id;
    if (node_id && this._node_els[node_id]) {
      this._node_els[node_id].classList.add("node--selected");
    }
  }

  revealAnswer(answer_node_id, user_node_id) {
    this.answer_id = answer_node_id;
    if (this._node_els[answer_node_id]) {
      this._node_els[answer_node_id].classList.add("node--correct");
    }
    if (
      user_node_id &&
      user_node_id !== answer_node_id &&
      this._node_els[user_node_id]
    ) {
      this._node_els[user_node_id].classList.add("node--wrong");
    }
  }

  // ── Private drawing helpers ─────────────────────────────────────────────────

  _drawNode(svg, node, pos, is_stressed) {
    const g = svgEl("g", {
      class: "node" + (is_stressed ? " node--stressed" : ""),
      "data-id": node.id,
    });
    g.style.cursor = "pointer";

    g.appendChild(
      svgEl("rect", {
        x: pos.x,
        y: pos.y,
        width: NODE_W,
        height: NODE_H,
        rx: 6,
        ry: 6,
        class: "node-rect",
      }),
    );

    // Node name.
    g.appendChild(
      svgText(node.name, {
        x: pos.cx,
        y: pos.y + 20,
        "text-anchor": "middle",
        class: "node-name",
      }),
    );

    // Capacity stats.
    g.appendChild(
      svgText(`conc: ${node.max_concurrency}  q: ${node.queue_limit}`, {
        x: pos.cx,
        y: pos.y + 38,
        "text-anchor": "middle",
        class: "node-stat",
      }),
    );

    g.appendChild(
      svgText(`latency: ${node.local_latency_ticks} ticks`, {
        x: pos.cx,
        y: pos.y + 54,
        "text-anchor": "middle",
        class: "node-stat",
      }),
    );

    // Token bucket (optional).
    if (node.token_bucket) {
      g.appendChild(
        svgText(
          `quota: ${node.token_bucket.capacity}  +${node.token_bucket.refill_rate}/t`,
          {
            x: pos.cx,
            y: pos.y + 70,
            "text-anchor": "middle",
            class: "node-quota",
          },
        ),
      );
    }

    // Stress indicator.
    if (is_stressed) {
      g.appendChild(
        svgText("⚡ STRESSOR", {
          x: pos.cx,
          y: pos.y + 84,
          "text-anchor": "middle",
          class: "node-stress-label",
        }),
      );
    }

    svg.appendChild(g);
    return g;
  }

  _drawEdge(svg, from, to, edge, is_stressed) {
    // Connect from right-centre of source to left-centre of target.
    // For same-layer connections (fan-in), use a curve.
    const x1 = from.x + NODE_W;
    const y1 = from.cy;
    const x2 = to.x;
    const y2 = to.cy;

    const dx = x2 - x1;
    const cp1x = x1 + dx * 0.4;
    const cp2x = x2 - dx * 0.4;

    const color_class = is_stressed
      ? "stress"
      : edge.mode === "SYNC"
        ? "sync"
        : "async";
    const marker = `url(#arrow-${color_class})`;

    const path = svgEl("path", {
      d: `M${x1},${y1} C${cp1x},${y1} ${cp2x},${y2} ${x2},${y2}`,
      class: `edge edge--${color_class}`,
      fill: "none",
      "marker-end": marker,
    });
    svg.appendChild(path);

    // Label group: background rect + text, returned to be appended after nodes.
    const lx = (x1 + x2) / 2;
    const ly = (y1 + y2) / 2 - 20;

    const lbl_g = svgEl("g");

    if (edge.mode === "SYNC") {
      // Two-line label: "SYNC" on top, "timeout:N" below.
      const timeout_str = `timeout:${edge.timeout_ticks}`;
      const label_w = Math.ceil(timeout_str.length * 5.5) + 8; // timeout line is wider

      lbl_g.appendChild(
        svgEl("rect", {
          x: lx - label_w / 2,
          y: ly - 10,
          width: label_w,
          height: 20,
          rx: 2,
          class: "edge-label-bg",
        }),
      );

      const txt = svgEl("text", {
        "text-anchor": "middle",
        class: `edge-label edge-label--${color_class}`,
      });
      const t1 = svgEl("tspan", { x: lx, dy: "0" });
      t1.textContent = "SYNC";
      const t2 = svgEl("tspan", { x: lx, dy: "10" });
      t2.textContent = timeout_str;
      txt.setAttribute("y", ly - 1);
      txt.appendChild(t1);
      txt.appendChild(t2);
      lbl_g.appendChild(txt);
    } else {
      // Single-line: "ASYNC"
      const label_w = Math.ceil("ASYNC".length * 5.5) + 8;
      lbl_g.appendChild(
        svgEl("rect", {
          x: lx - label_w / 2,
          y: ly - 9,
          width: label_w,
          height: 12,
          rx: 2,
          class: "edge-label-bg",
        }),
      );
      lbl_g.appendChild(
        svgText("ASYNC", {
          x: lx,
          y: ly,
          "text-anchor": "middle",
          class: `edge-label edge-label--${color_class}`,
        }),
      );
    }

    return lbl_g;
  }
}
