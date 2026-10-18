// D7 demo: replay engine, controls, diagnostics, B1/B2 panel and emergency mode. D8: analytics panels, keyboard,
// reduced motion. Static files only: no server, no API, no network use after the page loads.
import { loadVenue, loadReplay } from "../../planner/src/adapters/scenario_adapter.js";
import { createPredictor } from "../../planner/src/adapters/inference_adapter.js";
import { fetchAnalyticsRaw } from "../../planner/src/adapters/analytics_adapter.js";
import { errorStats } from "../../planner/src/plan/optimizer.js";
import { applyControls, DEFAULT_CONTROLS, CONTROL_LIMITS } from "./engine/controls.js";
import { createPlayback, pause, toggle, reset, seek, stepBy, setSpeed, tick, speed, SPEEDS } from "./engine/playback.js";
import { runScenario } from "./engine/scenario_runner.js";
import { warningState, UNCERTAIN_SIGMA_M } from "./engine/diagnostics.js";
import { BASELINE_NOTES } from "./engine/baselines.js";
import { shouldHandleShortcut, keyToAction } from "./engine/access.js";
import { buildAnalyticsViews, summariseViews } from "./panels/analytics_view.js";
import { renderAnalyticsPanels } from "./panels/analytics_panels.js";
import { buildOptimizerView } from "./panels/optimizer_view.js";
import { drawMap } from "./render/map.js";

const FIX = "../planner/fixtures/";
const $ = (id) => document.getElementById(id);
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const systemReduce = matchMedia("(prefers-reduced-motion: reduce)");
let reduceMotion = systemReduce.matches; // the switch in the controls starts from the system setting
const pct = (v) => (v == null ? "n/a" : `${(v * 100).toFixed(0)}%`);
const m = (v) => (v == null ? "n/a" : `${v.toFixed(2)} m`);

function row(dl, k, v) { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); }
function clear(el) { el.replaceChildren(); }

async function main() {
  const [venue, replay, predictor, analyticsRaw] = await Promise.all([
    loadVenue(FIX + "venue_office_standin.json"), loadReplay(FIX + "replay_office_standin.json"), createPredictor(),
    fetchAnalyticsRaw(FIX + "analytics.stand_in.json"),
  ]);
  const analyticsViews = buildAnalyticsViews(analyticsRaw); // a missing file gives "not yet generated" for every section
  const badge = $("predictor-badge");
  badge.textContent = predictor.is_mock ? "Predictor: MOCK (not the Traceline model)" : "Predictor: Traceline ONNX model";
  if (predictor.is_mock) badge.classList.add("mock");

  const canvas = $("map"), g = canvas.getContext("2d");
  let controls = { ...DEFAULT_CONTROLS, active_anchors: venue.anchors.length };
  let emergency = false;
  let scenario = null, outputs = null, token = 0;
  let player = createPlayback(replay.steps.length);
  let lastWarning = null;

  bindControls(venue, () => { controls = readControls(venue); recompute(); });
  $("emergency").addEventListener("change", (e) => { emergency = e.target.checked; document.body.classList.toggle("emergency", emergency); $("emergency-badge").hidden = !emergency; draw(); });
  $("play").addEventListener("click", () => { player = toggle(player); syncButtons(); });
  $("step-back").addEventListener("click", () => { player = stepBy(player, -1); draw(); });
  $("step-fwd").addEventListener("click", () => { player = stepBy(player, 1); draw(); });
  $("reset").addEventListener("click", () => { player = reset(player); draw(); });
  $("speed").addEventListener("change", (e) => { player = setSpeed(player, Number(e.target.value)); });
  $("scrub").addEventListener("input", (e) => { player = seek(pause(player), Number(e.target.value)); draw(); });
  $("reset-controls").addEventListener("click", () => { resetControlInputs(venue); controls = readControls(venue); recompute(); });
  document.addEventListener("keydown", (e) => {
    if (!shouldHandleShortcut(e.target)) return; // a focused control keeps its own keys
    const action = keyToAction(e.code, e);
    if (!action) return;
    e.preventDefault();
    if (action === "toggle") { player = toggle(player); syncButtons(); return; }
    if (action === "next") player = stepBy(player, 1);
    if (action === "previous") player = stepBy(player, -1);
    if (action === "first") player = seek(pause(player), 0);
    if (action === "last") player = seek(pause(player), replay.steps.length - 1);
    draw();
  });
  new ResizeObserver(() => draw()).observe(canvas);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => draw());
  $("reduce-motion").addEventListener("change", (e) => setReduceMotion(e.target.checked));
  systemReduce.addEventListener("change", (e) => { setReduceMotion(e.matches); $("reduce-motion").checked = e.matches; });

  $("scrub").max = String(replay.steps.length - 1);
  renderStatic(venue, replay);
  $("reduce-motion").checked = reduceMotion;
  setReduceMotion(reduceMotion);
  renderAnalyticsPanels($("analytics-panels"), analyticsViews);
  const optimizerReport = await fetch(FIX + "sample_optimizer.report.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  renderAnalyticsPanels($("optimizer-panel"), [buildOptimizerView(optimizerReport)]);
  $("analytics-summary").textContent = `Analytics: ${summariseViews(analyticsViews)}.`;
  row($("status"), "Analytics panels", summariseViews(analyticsViews));
  controls = readControls(venue);
  syncButtons();
  recompute();

  async function recompute() {
    const my = ++token;
    scenario = applyControls(venue, replay, controls);
    const result = await runScenario(predictor, venue, scenario);
    if (my !== token) return; // a newer change has started; drop this one
    outputs = result;
    draw();
  }

  let last = null;
  function frame(now) {
    if (last !== null && player.playing) {
      const before = player.index;
      player = tick(player, (now - last) / 1000);
      if (player.index !== before || !player.playing) { draw(); syncButtons(); }
    }
    last = now;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function syncButtons() {
    $("play").textContent = player.playing ? "Pause" : "Play";
    $("play").setAttribute("aria-pressed", String(player.playing));
    $("speed").value = String(player.speedIndex);
    $("scrub").value = String(player.index);
    $("step-label").textContent = `Step ${player.index + 1} of ${replay.steps.length}, t = ${(player.index * replay.dt_s).toFixed(1)} s, speed ${speed(player)}x`;
  }

  // Reduced motion: the map drops its trail fade. Playback has no easing animation, so nothing else moves on its own.
  function setReduceMotion(on) {
    reduceMotion = Boolean(on);
    document.body.classList.toggle("reduce-motion", reduceMotion);
    draw();
  }

  function draw() {
    if (!outputs) return;
    syncButtons();
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const colors = { ink: css("--ink"), accent: css("--accent"), warn: css("--warn"), muted: css("--muted"), line: css("--line"),
      crowd: css("--crowd"), restricted: css("--restricted"), walkable: css("--walkable"), panel: css("--panel") };
    drawMap(g, { w, h, venue, anchors: scenario.anchors, index: player.index, outputs, emergency, reduceMotion, colors });
    updateDiagnostics();
  }

  function updateDiagnostics() {
    const cur = outputs[player.index];
    const played = outputs.slice(0, player.index + 1);
    const err = (o) => Math.hypot(o.estimate.x_m - o.truth.x, o.estimate.y_m - o.truth.y);
    const warn = warningState({ outside: cur.out_of_bounds, valid_anchors: cur.valid_anchors, sigma_m: cur.sigma_m, suspected_nlos: cur.suspected_nlos });
    const d = $("diag"); clear(d);
    row(d, "Estimated X, Y", `${cur.estimate.x_m.toFixed(2)} m, ${cur.estimate.y_m.toFixed(2)} m`);
    row(d, "Uncertainty (1 sigma)", `${m(cur.sigma_m)} (mock, uncalibrated)`);
    row(d, "Valid anchors", `${cur.valid_anchors} of ${scenario.anchors.length} active`);
    row(d, "Suspected obstructed", cur.suspected_nlos.length ? cur.suspected_nlos.join(", ") : "none");
    row(d, "Forecast horizon", `+0.5 s to +2.0 s (4 steps), dotted`);
    row(d, "Error against truth now", m(err(cur)));
    row(d, "Reason", cur.reason_text);
    const w = $("warning"); w.textContent = `${warn.level === "ok" ? "OK" : "Warning"}: ${warn.text}`;
    w.dataset.level = warn.level;
    if (warn.level !== lastWarning) { $("live").textContent = w.textContent; lastWarning = warn.level; }

    const stats = errorStats(played.map(err));
    const bl = (key) => errorStats(played.map((o) => (o.baselines[key] ? Math.hypot(o.baselines[key].x_m - o.truth.x, o.baselines[key].y_m - o.truth.y) : null)).filter((x) => x != null));
    const t = $("runs"); clear(t);
    const add = (name, s, note) => { const tr = document.createElement("tr"); [name, s.steps, m(s.median_m), m(s.p90_m), note].forEach((v) => { const td = document.createElement("td"); td.textContent = String(v); tr.append(td); }); t.append(tr); };
    add("Predictor (" + (predictor.is_mock ? "mock" : "Traceline") + ")", stats, predictor.is_mock ? "stand-in" : "");
    add("B1 weighted LS", bl("b1"), "demo stand-in");
    add("B2 residual rejection", bl("b2"), "demo stand-in");
    add("B3 Kalman", { steps: 0, median_m: null, p90_m: null }, BASELINE_NOTES.b3.split(":")[0]);

    const flags = played.filter((o) => o.sigma_m > UNCERTAIN_SIGMA_M || o.out_of_bounds).length;
    $("emergency-note").textContent = emergency
      ? `Emergency view: priority asset is the tracked target. ${flags} of ${played.length} played steps are flagged uncertain or outside the venue. Prioritisation view only, not a clinical or safety system.`
      : "";
    const aria = `Venue map. Step ${player.index + 1}. Estimate ${cur.estimate.x_m.toFixed(1)}, ${cur.estimate.y_m.toFixed(1)} metres; truth ${cur.truth.x.toFixed(1)}, ${cur.truth.y.toFixed(1)} metres. ${w.textContent}`;
    canvas.setAttribute("aria-label", aria);
    $("map-desc").textContent = aria;
  }
}

function bindControls(venue, onChange) {
  for (const id of ["anchors", "noise", "dropout", "obstruction", "crowd"]) {
    $(id).addEventListener("input", (e) => { e.target.nextElementSibling.textContent = labelFor(id, e.target.value); });
    $(id).addEventListener("change", onChange);
  }
}
function labelFor(id, v) {
  return ({ anchors: `${v} anchors`, noise: `${Number(v).toFixed(1)}x noise`, dropout: `+${Math.round(v * 100)}% dropout`,
    obstruction: `${Math.round(v * 100)}% of recorded obstruction bias`, crowd: `${Number(v).toFixed(1)} people/m2 in crowd zones` })[id];
}
function readControls(venue) {
  return { active_anchors: Number($("anchors").value), noise_multiplier: Number($("noise").value), extra_dropout: Number($("dropout").value),
    obstruction_scale: Number($("obstruction").value), crowd_density: Number($("crowd").value), seed: 1 };
}
function resetControlInputs(venue) {
  const d = { anchors: venue.anchors.length, noise: 1, dropout: 0, obstruction: 1, crowd: 0 };
  for (const [id, v] of Object.entries(d)) { $(id).value = String(v); $(id).nextElementSibling.textContent = labelFor(id, v); }
}

function renderStatic(venue, replay) {
  const st = $("status"); clear(st);
  row(st, "Venue", `${venue.venue_id}, ${venue.width_m} x ${venue.height_m} m (stand-in)`);
  row(st, "Scenario", `${replay.scenario_id}, ${replay.steps.length} steps, recorded replay (stand-in)`);
  row(st, "Anchors", `${venue.anchors.length} in the venue`);
  // control labels start in sync with the inputs
  $("anchors").min = String(Math.min(CONTROL_LIMITS.active_anchors[0], venue.anchors.length));
  $("anchors").max = String(venue.anchors.length); $("anchors").value = String(venue.anchors.length);
  resetControlInputs(venue);
  for (const id of ["anchors", "noise", "dropout", "obstruction", "crowd"]) $(id).nextElementSibling.textContent = labelFor(id, $(id).value);
  const speedSel = $("speed"); clear(speedSel);
  SPEEDS.forEach((s, i) => { const o = document.createElement("option"); o.value = String(i); o.textContent = `${s}x`; speedSel.append(o); });
  speedSel.value = "2";
}

main().catch((err) => {
  const p = document.createElement("p");
  p.setAttribute("role", "alert");
  p.textContent = "The demo could not start: " + err.message + " Serve the repository root with `make demo` instead of opening the file directly.";
  document.querySelector("main").prepend(p);
});
