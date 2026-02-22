"use strict";

// ─── Seed encoding (base-26, 7 lowercase letters) ─────────────────────────────
// All unsigned 32-bit seeds (0–4,294,967,295) map to unique 7-letter codes
// because 26^7 = 8,031,810,176 > 4,294,967,295.
const ALPHA = "abcdefghijklmnopqrstuvwxyz";

function seedToCode(seed) {
  let n = seed >>> 0;
  let s = "";
  for (let i = 0; i < 7; i++) {
    s = ALPHA[n % 26] + s;
    n = Math.floor(n / 26);
  }
  return s;
}

function codeToSeed(code) {
  const clean = String(code)
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (clean.length !== 7) return null;
  let n = 0;
  for (const c of clean) n = n * 26 + (c.charCodeAt(0) - 97);
  return n >>> 0;
}

function seedFromHash() {
  const m = window.location.hash.match(/[#&]seed=([a-zA-Z]{7})/i);
  return m ? codeToSeed(m[1]) : null;
}

// ─── State ───────────────────────────────────────────────────────────────────
let scenario = null;
let selected_node = null;
let selected_type = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $stressor = document.getElementById("stressor-desc");
const $arrival = document.getElementById("arrival-rate");
const $policy = document.getElementById("system-policy");
const $graph = document.getElementById("graph-container");
const $selected = document.getElementById("selected-node-display");
const $type_btns = document.querySelectorAll(".failure-btn");
const $submit = document.getElementById("submit-btn");
const $result = document.getElementById("result-panel");
const $verdict = document.getElementById("result-verdict");
const $explanation = document.getElementById("result-explanation");
const $peaks = document.getElementById("result-peaks");
const $next = document.getElementById("next-btn");
const $seed_el = document.getElementById("seed-display");
const $version_el = document.getElementById("version-display");
const $help_btn = document.getElementById("help-btn");
const $help_overlay = document.getElementById("help-overlay");
const $help_close = document.getElementById("help-close");

// ─── Graph renderer ───────────────────────────────────────────────────────────
const renderer = new GraphRenderer($graph, onNodeClick);

// ─── Game logic ───────────────────────────────────────────────────────────────
function loadScenario(seed) {
  scenario = generateScenario(seed);
  selected_node = null;
  selected_type = null;

  // Stressor panel.
  $stressor.textContent = scenario.stressor.description;
  $arrival.textContent = `Arrival rate: ${scenario.stressed_arrival_rate} requests/tick`;
  const retry_str =
    scenario.max_retries > 0
      ? `retries: ${scenario.max_retries} (exp. backoff)`
      : "retries: none";
  $policy.textContent = `SYNC calls: per-edge timeout · ${retry_str} · no time deadline`;

  // Graph.
  renderer.render(scenario);

  // Quiz panel.
  $selected.textContent = "No node selected";
  $selected.className = "";
  $type_btns.forEach((b) => b.classList.remove("active"));
  $submit.disabled = true;

  // Result panel.
  $result.hidden = true;
  $result.className = "";
  $peaks.hidden = true;

  // Seed display — clicking the code permalinks the current scenario.
  const code = seedToCode(scenario.seed);
  $seed_el.textContent = code;
  $seed_el.href = "#seed=" + code;
}

function onNodeClick(node_id) {
  if (!$result.hidden) return; // guessing phase only

  selected_node = node_id;
  renderer.selectNode(node_id);

  const node = scenario.nodes.find((n) => n.id === node_id);
  $selected.textContent = node ? node.name : node_id;
  $selected.className = "has-selection";

  updateSubmit();
}

function onTypeClick(type) {
  if (!$result.hidden) return;

  selected_type = type;
  $type_btns.forEach((b) => {
    b.classList.toggle("active", b.dataset.type === type);
  });
  updateSubmit();
}

function updateSubmit() {
  $submit.disabled = !(selected_node && selected_type);
}

function submitGuess() {
  const answer = scenario.answer;

  if (!answer) {
    // The simulation found no failure — edge case.
    $verdict.textContent = "The system held stable under this stressor.";
    $verdict.className = "verdict--stable";
    $explanation.textContent = scenario.stressor.description;
    $result.hidden = false;
    return;
  }

  const correct_node = selected_node === answer.node_id;
  const correct_type = selected_type === answer.failure_type;
  const fully_correct = correct_node && correct_type;

  // Reveal on graph.
  renderer.selectNode(null);
  renderer.revealAnswer(answer.node_id, selected_node);

  // Verdict text.
  const correct_name =
    scenario.nodes.find((n) => n.id === answer.node_id)?.name ?? answer.node_id;
  const tick_note = `  ·  tick ${answer.tick}`;
  if (fully_correct) {
    $verdict.innerHTML = `<i class="ph-light ph-check-circle"></i> Correct. Your system analysis hat is working.${tick_note}`;
    $verdict.className = "verdict--correct";
  } else if (correct_node) {
    $verdict.innerHTML = `<i class="ph-light ph-warning"></i> Right node, wrong failure type. It was: ${labelForType(answer.failure_type)}.${tick_note}`;
    $verdict.className = "verdict--partial";
  } else if (correct_type) {
    $verdict.innerHTML = `<i class="ph-light ph-warning"></i> Right failure type, wrong node. The failure was at: ${correct_name}.${tick_note}`;
    $verdict.className = "verdict--partial";
  } else {
    $verdict.innerHTML = `<i class="ph-light ph-x-circle"></i> Incorrect. Failed at ${correct_name} (${labelForType(answer.failure_type)}).${tick_note}`;
    $verdict.className = "verdict--wrong";
  }

  // Explanation.
  $explanation.textContent = answer.explanation;

  // Queue peaks (diagnostic).
  if (answer.node_peaks) {
    const peak_lines = scenario.nodes.map((n) => {
      const peak = answer.node_peaks[n.id] ?? 0;
      const bar = "█".repeat(Math.min(peak, 20)) || "·";
      return `${n.name.padEnd(24)} q_peak: ${String(peak).padStart(3)}  ${bar}`;
    });
    $peaks.textContent = peak_lines.join("\n");
    $peaks.hidden = false;
  }

  $result.hidden = false;
}

function labelForType(type) {
  return (
    {
      QUEUE_DROP: "Queue Drop (OOM)",
      TIMEOUT_CASCADE: "Timeout Cascade",
      DEADLINE_EXCEEDED: "Deadline Exceeded",
      RATE_LIMIT_DROP: "Rate Limited",
    }[type] ?? type
  );
}

// ─── Event listeners ─────────────────────────────────────────────────────────
$type_btns.forEach((b) =>
  b.addEventListener("click", () => onTypeClick(b.dataset.type)),
);
$submit.addEventListener("click", submitGuess);
$next.addEventListener("click", () => loadScenario());

$help_btn.addEventListener("click", () => { $help_overlay.classList.add("is-open"); });
$help_close.addEventListener("click", () => { $help_overlay.classList.remove("is-open"); });
$help_overlay.addEventListener("click", (e) => {
  if (e.target === $help_overlay) $help_overlay.classList.remove("is-open");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $help_overlay.classList.remove("is-open");
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
fetch("manifest.json")
  .then((r) => r.json())
  .then((m) => {
    if (m.version) {
      $version_el.textContent = m.version;
      const $intro_v = document.getElementById("intro-version");
      if ($intro_v) $intro_v.textContent = `v${m.version}`;
    }
  })
  .catch(() => {});

// Intro screen: clicking the button fades it out and reveals the app.
const $intro = document.getElementById("intro-screen");
document.getElementById("intro-begin-btn").addEventListener("click", () => {
  $intro.classList.add("hidden");
  // Remove from tab order after transition.
  $intro.addEventListener("transitionend", () => { $intro.style.display = "none"; }, { once: true });
});

loadScenario(seedFromHash());
