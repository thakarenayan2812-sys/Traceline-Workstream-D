// Thin browser layer over src/plan/*. All behaviour lives in editor.js and is unit-tested;
// this file only draws, forwards events and reads/writes files locally. Nothing is sent anywhere.
import { createEditor, TOOLS, TOOL_LABELS } from "../plan/editor.js";
import { fitViewport, imageToScreen, screenToImage, zoomAt, panBy } from "../plan/viewport.js";
import { validatePlan } from "../plan/plan_validate.js";
import { buildPlanJson, toVenue, planFromJson } from "../plan/plan_export.js";
import { validateImageFile, validateImageSize, sniffImageType } from "../plan/image_check.js";
import { ZONE_TYPES } from "../core/constants.js";
import { metresToImagePx } from "../core/transforms.js";
import { buildCoverageProblem, venueWithAnchors, layoutCounts, evaluateLayout } from "../plan/coverage.js";
import { searchMinimumAnchors } from "../plan/search.js";
import { buildCoverageReport, anchorsCsv, SITE_SURVEY_WARNING } from "../plan/coverage_report.js";
import { compareCrowd, buildCrowdComparisonReport, crowdComparisonCsv, crowdAnchorsCsv } from "../plan/crowd_compare.js";
import { runAnchorOptimizer } from "../plan/optimizer.js";
import { buildOptimizerReport, rankingCsv } from "../plan/optimizer_report.js";

const $ = (id) => document.getElementById(id);
const ed = createEditor();
const canvas = $("stage"), ctx = canvas.getContext("2d");
let img = null, imageUrl = null, vp = null, autoFit = true, cursor = null, cursorVisible = false;
let pan = null, down = null;
let cov = null, running = false, stopFlag = false;   // cov = {result, problem, plan, planJson, counts}
let crowdCmp = null;                                 // {cmp, plan, planJson} from compareCrowd
let optRun = null;                                  // {result, plan, planJson} from runAnchorOptimizer
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------- setup
const toolsEl = $("tools");
for (const t of TOOLS) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = TOOL_LABELS[t]; b.dataset.tool = t;
  b.addEventListener("click", () => { ed.setTool(t); refresh(); canvas.focus(); });
  toolsEl.append(b);
}
for (const z of ZONE_TYPES) { const o = document.createElement("option"); o.value = o.textContent = z; $("zonetype").append(o); }

// ---------- file handling (local only)
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256(bytes) { try { return hex(await crypto.subtle.digest("SHA-256", bytes)); } catch { return null; } }
function showUploadErrors(list) { const ul = $("upload-errors"); ul.replaceChildren(...list.map((m) => li("err", m))); }
function li(cls, text) { const e = document.createElement("li"); e.className = cls; e.textContent = text; return e; }

async function loadImageFile(file) {
  showUploadErrors([]);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const errs = validateImageFile({ size_bytes: file.size, bytes });
  if (errs.length) return showUploadErrors(errs);
  const url = URL.createObjectURL(new Blob([bytes], { type: sniffImageType(bytes) === "png" ? "image/png" : "image/jpeg" }));
  const im = new Image();
  im.src = url;
  try { await im.decode(); } catch { URL.revokeObjectURL(url); return showUploadErrors(["The browser could not read this image. It may be damaged. Try exporting it again."]); }
  const sizeErrs = validateImageSize(im.naturalWidth, im.naturalHeight);
  if (sizeErrs.length) { URL.revokeObjectURL(url); return showUploadErrors(sizeErrs); }
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = url; img = im; autoFit = true;
  ed.setImage({ filename: file.name, width_px: im.naturalWidth, height_px: im.naturalHeight, sha256: await sha256(bytes) });
  fit(); refresh();
}
$("file").addEventListener("change", (e) => e.target.files[0] && loadImageFile(e.target.files[0]));
canvas.addEventListener("dragover", (e) => e.preventDefault());
canvas.addEventListener("drop", (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadImageFile(f); });

$("load-plan").addEventListener("change", async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  const cur = ed.snapshot().plan.image;
  if (!cur) return setMsg("Choose the original floor-plan image first, then load its plan.json.");
  try {
    const p = planFromJson(JSON.parse(await f.text()));
    if (p.image.width_px !== cur.width_px || p.image.height_px !== cur.height_px)
      return setMsg(`This plan.json was traced on a ${p.image.width_px} x ${p.image.height_px} px image, but the current image is ${cur.width_px} x ${cur.height_px} px. Choose the original image.`);
    const same = !p.image.sha256 || !cur.sha256 || p.image.sha256 === cur.sha256;
    ed.loadPlan({ ...p, image: cur });
    refresh();
    setMsg(same ? "Plan loaded." : "Plan loaded, but the image differs from the one it was traced on. Check that the tracing lines up.");
  } catch (err) { setMsg("Could not load plan.json: " + err.message); }
});

function download(name, text, mime = "application/json") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$("export-plan").addEventListener("click", () => { download("plan.json", JSON.stringify(buildPlanJson(ed.snapshot().plan, { settings: readSettings() }), null, 2) + "\n"); setMsg("plan.json saved to your computer."); });
$("export-venue").addEventListener("click", () => { download("venue.json", JSON.stringify(toVenue(ed.snapshot().plan), null, 2) + "\n"); setMsg("venue.json saved to your computer."); });

// ---------- options and buttons
let overrideMsg = null;
const setMsg = (m) => { overrideMsg = m; $("message").textContent = m; };
const act = (fn) => () => { overrideMsg = null; fn(); refresh(); };
$("known").addEventListener("input", (e) => { ed.setKnownDistance(parseFloat(e.target.value)); refresh(false); });
$("material").addEventListener("change", (e) => ed.setOption("wall_material", e.target.value));
$("chain").addEventListener("change", (e) => ed.setOption("chain_walls", e.target.checked));
$("zonetype").addEventListener("change", (e) => { ed.setOption("zone_type", e.target.value); refresh(); });
$("zonename").addEventListener("input", (e) => ed.setOption("zone_name", e.target.value));
$("density").addEventListener("input", (e) => ed.setOption("density_people_m2", e.target.value === "" ? null : parseFloat(e.target.value)));
$("finish").addEventListener("click", act(() => ed.finish()));
$("cancel").addEventListener("click", act(() => ed.cancel()));
$("undo").addEventListener("click", act(() => ed.undo()));
$("redo").addEventListener("click", act(() => ed.redo()));
$("reset").addEventListener("click", act(() => ed.reset()));
$("zin").addEventListener("click", () => zoomCentre(1.25));
$("zout").addEventListener("click", () => zoomCentre(1 / 1.25));
$("zfit").addEventListener("click", () => { autoFit = true; fit(); draw(); });
$("items").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-kind]"); if (!b) return;
  overrideMsg = null; ed.deleteItem(b.dataset.kind, b.dataset.id); refresh();
});


// ---------- coverage search
const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : null; };
function readSettings() {
  return { max_range_m: num("range"), grid_resolution_m: num("res"), candidate_spacing_m: num("spacing"), search_budget: num("budget"),
    max_anchors: num("maxa"), seed: num("seed"),
    mounting_constraints: { mode: $("mount").value, exclude_zone_types: $("norestricted").checked ? ["restricted"] : [] } };
}
const setRun = (m) => { $("run-status").textContent = m; };
const REASONS = {
  infeasible_cells: "Some areas cannot be reached by enough candidate positions (blocked by walls or out of range). Extend the range, add candidate positions or check the walls.",
  budget: "The search budget ran out before a full layout was built. Raise the search budget.",
  max_anchors: "The maximum number of anchors was reached before the criterion was met.",
  stopped: "The search was stopped.",
};
$("run").addEventListener("click", async () => {
  const snap = ed.snapshot(), v = validatePlan(snap.plan), st = readSettings();
  if (v.errors.length) return setRun("Fix the problems under Checks first.");
  if (!(st.max_range_m > 0)) return setRun("Enter the assumed maximum range in metres first.");
  running = true; stopFlag = false; cov = null; $("run").disabled = true; $("stop").disabled = false;
  setRun("Preparing line-of-sight checks...");
  await new Promise((r) => setTimeout(r, 20));
  try {
    const planJson = buildPlanJson(snap.plan, { settings: st }), venue = toVenue(snap.plan);
    const problem = buildCoverageProblem(venue, { max_range_m: st.max_range_m, resolution_m: st.grid_resolution_m,
      candidate_spacing_m: st.candidate_spacing_m, mounting: st.mounting_constraints });
    setRun(`Searching (${problem.candidates.length} candidate positions, ${problem.N} cells)...`);
    const result = await searchMinimumAnchors(problem, { seed: st.seed ?? 1, budget: st.search_budget, max_anchors: st.max_anchors,
      yieldEvery: 400, yieldFn: () => new Promise((r) => setTimeout(r)), shouldStop: () => stopFlag });
    cov = { result, problem, plan: snap.plan, planJson, counts: layoutCounts(problem, result._layout) };
    setRun(result.label + ".");
  } catch (e) { setRun("Could not run the search: " + e.message); }
  running = false; refresh();
});
$("stop").addEventListener("click", () => { stopFlag = true; setRun("Stopping..."); });
$("show-cov").addEventListener("change", draw);
$("export-report").addEventListener("click", async () => {
  if (!cov) return;
  download("coverage_report.json", JSON.stringify(await buildCoverageReport({ result: cov.result, problem: cov.problem, planJson: cov.planJson }), null, 2) + "\n");
  setMsg("coverage_report.json saved to your computer.");
});
$("export-anchors").addEventListener("click", () => { if (cov) { download("anchors.csv", anchorsCsv(cov.result), "text/csv"); setMsg("anchors.csv saved to your computer."); } });
$("export-venue-anchors").addEventListener("click", () => {
  if (!cov) return;
  try {
    const v = venueWithAnchors(toVenue(cov.plan), cov.result.anchors.map((a) => ({ x: a.x_m, y: a.y_m })));
    download("venue_with_anchors.json", JSON.stringify(v, null, 2) + "\n"); setMsg("venue_with_anchors.json saved to your computer.");
  } catch (e) { setMsg(e.message); }
});

// ---------- crowd-aware planning (D5)
const setCrowd = (m) => { $("c-status").textContent = m; };
const CROWD_VIEWS = {
  aware: (c) => ({ problem: c._problems.aware, layout: c._layouts.aware }),
  unaware_crowd: (c) => ({ problem: c._problems.aware, layout: c._layouts.unaware }),
  unaware_plain: (c) => ({ problem: c._problems.plain, layout: c._layouts.unaware }),
};
/** What the plan canvas shows: the crowd view chosen under Crowd-aware planning, else the coverage result. */
function overlay() {
  const v = $("c-view").value;
  if (crowdCmp && v !== "coverage" && CROWD_VIEWS[v]) {
    const { problem, layout } = CROWD_VIEWS[v](crowdCmp.cmp);
    const ev = evaluateLayout(problem, layout), { counts, ...coverage } = ev;
    return { problem, planJson: crowdCmp.planJson, counts,
      result: { anchors: layout.map((j, i) => ({ anchor_id: i, x_m: problem.candidates[j].x, y_m: problem.candidates[j].y })), coverage } };
  }
  return cov;
}
$("c-view").addEventListener("change", draw);
$("c-run").addEventListener("click", async () => {
  const snap = ed.snapshot(), v = validatePlan(snap.plan), st = readSettings();
  if (v.errors.length) return setCrowd("Fix the problems under Checks first.");
  if (!(st.max_range_m > 0)) return setCrowd("Enter the assumed maximum range in metres first.");
  running = true; stopFlag = false; crowdCmp = null; $("c-run").disabled = true; $("c-stop").disabled = false;
  setCrowd("Preparing the with-crowd and without-crowd problems...");
  await new Promise((r) => setTimeout(r, 20));
  try {
    const planJson = buildPlanJson(snap.plan, { settings: st }), venue = toVenue(snap.plan);
    const fb = num("c-fallback"), model = { range_derate_per_density: num("c-derate"), min_range_factor: num("c-minf"),
      density_per_extra_anchor: num("c-perx"), max_extra_anchors: num("c-maxx") };
    for (const k of Object.keys(model)) if (model[k] === null) delete model[k];
    const cmp = await compareCrowd(venue, { max_range_m: st.max_range_m, resolution_m: st.grid_resolution_m ?? undefined,
      candidate_spacing_m: st.candidate_spacing_m ?? undefined, mounting: st.mounting_constraints, crowd_model: model, fallback_density: fb },
    { seed: st.seed ?? 1, budget: st.search_budget, max_anchors: st.max_anchors, yieldEvery: 400, yieldFn: () => new Promise((r) => setTimeout(r)), shouldStop: () => stopFlag });
    crowdCmp = { cmp, plan: snap.plan, planJson };
    $("c-view").value = "aware";
    setCrowd(cmp.status === "ok" ? "Comparison finished." : "Comparison finished, but one search did not meet the criterion. See the warnings.");
  } catch (e) { setCrowd("Could not run the comparison: " + e.message); }
  running = false; $("c-stop").disabled = true; refresh();
});
$("c-stop").addEventListener("click", () => { stopFlag = true; setCrowd("Stopping..."); });
$("c-export-report").addEventListener("click", async () => {
  if (!crowdCmp) return;
  download("crowd_comparison.report.json", JSON.stringify(await buildCrowdComparisonReport({ cmp: crowdCmp.cmp, planJson: crowdCmp.planJson }), null, 2) + "\n");
  setMsg("crowd_comparison.report.json saved to your computer.");
});
$("c-export-regions").addEventListener("click", () => { if (crowdCmp) { download("crowd_comparison.regions.csv", crowdComparisonCsv(crowdCmp.cmp), "text/csv"); setMsg("crowd_comparison.regions.csv saved to your computer."); } });
$("c-export-anchors").addEventListener("click", () => { if (crowdCmp) { download("crowd_comparison.anchors.csv", crowdAnchorsCsv(crowdCmp.cmp), "text/csv"); setMsg("crowd_comparison.anchors.csv saved to your computer."); } });

// ---------- anchor placement optimizer (D6, in the browser)
const setOpt = (m) => { $("o-status").textContent = m; };
const optM = (v) => (v == null ? "n/a" : v.toFixed(2) + " m");
$("o-run").addEventListener("click", async () => {
  const snap = ed.snapshot(), v = validatePlan(snap.plan), st = readSettings();
  if (v.errors.length) return setOpt("Fix the problems under Checks first.");
  if (!(st.max_range_m > 0)) return setOpt("Enter the assumed maximum range in metres first.");
  running = true; optRun = null; $("o-run").disabled = true;
  setOpt("Ranking layouts. This can take a while on a large plan; the page stays responsive.");
  await new Promise((r) => setTimeout(r, 20));
  try {
    const planJson = buildPlanJson(snap.plan, { settings: st }), venue = toVenue(snap.plan);
    const result = await runAnchorOptimizer(venue, {
      max_range_m: st.max_range_m, resolution_m: st.grid_resolution_m ?? 1, candidate_spacing_m: st.candidate_spacing_m ?? 2,
      mounting: st.mounting_constraints, fallback_density: num("c-fallback"), seed: st.seed ?? 1,
      budget: st.search_budget ?? 20000, max_anchors: st.max_anchors ?? 40,
    }, { yieldFn: () => new Promise((r) => setTimeout(r)) });
    optRun = { result, plan: snap.plan, planJson };
    setOpt(result.best ? "Ranking finished." : "Ranking finished. No layout met the coverage criterion. See the warnings.");
  } catch (e) { setOpt("Could not run the optimizer: " + e.message); }
  running = false; refresh();
});
$("o-export-report").addEventListener("click", async () => {
  if (!optRun) return;
  download("optimizer.report.json", JSON.stringify(await buildOptimizerReport({ result: optRun.result, planJson: optRun.planJson }), null, 2) + "\n");
  setMsg("optimizer.report.json saved to your computer.");
});
$("o-export-ranking").addEventListener("click", () => { if (optRun) { download("optimizer.ranking.csv", rankingCsv(optRun.result), "text/csv"); setMsg("optimizer.ranking.csv saved to your computer."); } });

function simpleTable(caption, headers, rows) {
  const t = document.createElement("table"); t.className = "runs";
  const cap = document.createElement("caption"); cap.textContent = caption; cap.className = "hint"; t.append(cap);
  const head = document.createElement("tr");
  for (const h of headers) { const th = document.createElement("th"); th.scope = "col"; th.textContent = h; head.append(th); }
  const thead = document.createElement("thead"); thead.append(head); t.append(thead);
  const tb = document.createElement("tbody");
  for (const r of rows) { const tr = document.createElement("tr"); for (const c of r) { const td = document.createElement("td"); td.textContent = String(c); tr.append(td); } tb.append(tr); }
  t.append(tb);
  const wrap = document.createElement("div"); wrap.className = "tbl"; wrap.tabIndex = 0; wrap.setAttribute("role", "region"); wrap.setAttribute("aria-label", caption);
  wrap.append(t);
  return wrap;
}

function renderOptimizer() {
  const box = $("o-result");
  $("o-export-report").disabled = $("o-export-ranking").disabled = !optRun;
  if (!optRun) { box.replaceChildren(); return; }
  const r = optRun.result, byId = Object.fromEntries(r.layouts.map((L) => [L.layout_id, L]));
  const verdict = document.createElement("p"); verdict.className = "verdict";
  if (r.best) { const b = byId[r.best]; verdict.textContent = `Best of the candidates: ${r.best}, ${b.k} anchors, simulated P90 ${optM(b.simulated.p90_m)}.`; }
  else verdict.textContent = "No best layout: no candidate met the coverage criterion.";
  const judged = document.createElement("p"); judged.className = "hint";
  judged.textContent = `Judged by ${r.judged_by}. Errors are simulated, not measured. Pareto-optimal layouts trade anchors against error. "Best" means best of these candidates, not a proven optimum.`;
  const rank = simpleTable("Ranked layouts", ["Rank", "Layout", "Anchors", "Criterion met", "Median", "P90", "Inside crowd P90", "Pareto"],
    r.ranking.map((id) => byId[id]).filter(Boolean).map((L) => [L.rank, L.layout_id, L.k, L.coverage.criterion_met ? "yes" : "no",
      optM(L.simulated.median_m), optM(L.simulated.p90_m), optM(L.simulated.inside_crowd?.p90_m), L.pareto_optimal ? "yes" : "no"]));
  const naive = simpleTable("Optimised layout against a naive grid of the same size", ["Anchors", "Optimised P90", "Naive grid P90", "Naive meets criterion"],
    r.naive_comparison.map((n) => [n.k, optM(n.optimised_p90_m), optM(n.naive_p90_m), n.naive_criterion_met ? "yes" : "no"]));
  const warns = document.createElement("ul"); warns.className = "problems";
  for (const w of r.warnings) warns.append(li("warn", "Warning: " + w));
  box.replaceChildren(verdict, judged, rank, naive, warns);
}

function renderCrowd() {
  const box = $("c-result");
  if (!crowdCmp) { box.replaceChildren(); return; }
  const c = crowdCmp.cmp, d = c.difference, J = c.judged_by_crowd_aware_criterion, pct = (f) => (f == null ? "n/a" : (f * 100).toFixed(1) + "%");
  const verdict = document.createElement("p"); verdict.className = "verdict";
  verdict.textContent = (c.status === "ok" ? "\u2714 " : "\u26A0 ") + `Without crowd zones ${d.anchors_unaware} anchors; with the crowd model ${d.anchors_aware} (${d.extra_anchors_for_crowds >= 0 ? "+" : ""}${d.extra_anchors_for_crowds}).`;
  const dl = document.createElement("dl"); dl.className = "res";
  const row = (k, v) => { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); };
  row("Crowd zones", c.zones.map((z) => `${z.name || z.zone_id}: ${z.density_people_m2}/m2${z.density_source === "fallback" ? " (fallback)" : ""}`).join("; "));
  const names = { unaware: "Ignoring crowds", aware: "Crowd-aware", naive_grid_same_k: "Naive grid, crowd-aware count" };
  for (const [k, j] of Object.entries(J))
    row(names[k] + ` (${j.anchors})`, `inside crowd: ${pct(j.regions.inside_crowd.uncovered_fraction)} uncovered, ${j.regions.inside_crowd.mean_usable_anchors ?? "n/a"} usable on average; outside: ${pct(j.regions.outside_crowd.uncovered_fraction)} uncovered`);
  row("Search noise", `Two seeds differ by ${d.search_variation_anchors} anchor(s). The extra anchors are ${d.extra_exceeds_search_variation ? "larger than that, so they are a real difference for this setup." : "not larger than that, so they cannot be told apart from search noise."}`);
  row("Anchor changes", `${d.kept.length} kept, ${d.added_for_crowds.length} added, ${d.removed_by_crowds.length} removed. Searches with different seeds share only ${d.seed_control.shared_with_unaware} anchors, so positions mostly reflect search variation.`);
  row("Positioning error", "Not yet generated. Median and P90 error under crowds need the simulator adapter (D6).");
  const warns = document.createElement("ul"); warns.className = "problems";
  for (const w of c.warnings) warns.append(li("warn", "Warning: " + w));
  const model = document.createElement("p"); model.className = "hint"; model.textContent = c.crowd_model_description.join(" ");
  box.replaceChildren(verdict, dl, warns, model);
}

function renderCoverage() {
  const box = $("cov-result");
  if (!cov) { box.replaceChildren(); return; }
  const r = cov.result, c = r.coverage, o = cov.problem.options, pct = (f) => (f * 100).toFixed(2) + "%";
  const verdict = document.createElement("p"); verdict.className = "verdict";
  verdict.textContent = (r.status === "met" ? "\u2714 " : "\u26A0 ") + r.label;
  const dl = document.createElement("dl"); dl.className = "res";
  const row = (k, v) => { const dt = document.createElement("dt"), dd = document.createElement("dd"); dt.textContent = k; dd.textContent = v; dl.append(dt, dd); };
  row("Anchors in layout", String(r.k));
  row("Lower bound", `${r.lower_bound} (valid for these candidate positions)`);
  if (r.greedy_pruned_size != null) row("Greedy baseline", String(r.greedy_pruned_size));
  row("Uncovered area", `${pct(c.uncovered_fraction)} of the walkable area (${c.uncovered_area_m2.toFixed(1)} m2)`);
  row("Weakest point", `(${c.worst_case.x_m.toFixed(2)}, ${c.worst_case.y_m.toFixed(2)}) m with ${c.worst_case.usable_anchors} usable anchors`);
  row("Grid resolution", `${o.resolution_m} m, ${c.walkable_cells} cells`);
  row("Assumed range", `${o.max_range_m} m`);
  row("Candidate positions", `${r.search.candidates} (spacing ${o.candidate_spacing_m} m, ${o.mounting.mode === "wall_mounted" ? "beside walls" : "floor lattice"})`);
  row("Search budget used", `${r.search.evaluations_used} of ${r.search.budget} evaluations, seed ${r.search.seed}`);
  row("Naive grid, same count", `${pct(r.naive_grid.same_k.uncovered_fraction)} uncovered`);
  row("Naive grid needs", r.naive_grid.min_k_to_meet != null ? `${r.naive_grid.min_k_to_meet} anchors` : `more than ${Math.max(r.search.max_anchors, r.k)} anchors`);
  const warns = document.createElement("ul"); warns.className = "problems";
  if (r.status === "not_met") warns.append(li("warn", "Warning: " + (REASONS[r.reason] ?? "The criterion was not met.")));
  if (r.exceeds_model_slots) warns.append(li("warn", `Warning: this layout needs ${r.k} anchors, but the model supports at most 8, so it cannot be exported into a venue file.`));
  warns.append(li("warn", "Warning: " + SITE_SURVEY_WARNING));
  box.replaceChildren(verdict, dl, warns);
}

// ---------- viewport
function fit() { if (img) vp = fitViewport(img.naturalWidth, img.naturalHeight, canvas.clientWidth, canvas.clientHeight); }
function zoomCentre(f) { if (!vp) return; autoFit = false; vp = zoomAt(vp, { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 }, f); draw(); }
new ResizeObserver(() => { if (autoFit) fit(); draw(); }).observe(canvas);
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);

// ---------- pointer
const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
canvas.addEventListener("pointermove", (e) => {
  if (!vp) return;
  const p = local(e);
  if (pan) { vp = panBy(vp, p.x - pan.x, p.y - pan.y); pan = p; autoFit = false; }
  cursor = screenToImage(p, vp); cursorVisible = true; draw();
});
canvas.addEventListener("pointerleave", () => { cursorVisible = document.activeElement === canvas && !!cursor; draw(); });
canvas.addEventListener("pointerdown", (e) => {
  if (!vp) return;
  canvas.setPointerCapture(e.pointerId);
  const p = local(e);
  if (e.button === 1 || e.shiftKey) { pan = p; e.preventDefault(); } else down = p;
});
canvas.addEventListener("pointerup", (e) => {
  const p = local(e);
  if (pan) { pan = null; return; }
  if (down && vp && Math.hypot(p.x - down.x, p.y - down.y) < 5 && e.button === 0) { overrideMsg = null; ed.click(screenToImage(p, vp)); refresh(); }
  down = null;
});
canvas.addEventListener("dblclick", () => { overrideMsg = null; if (ed.snapshot().draft.length >= 3) ed.finish(); refresh(); });
canvas.addEventListener("wheel", (e) => {
  if (!vp) return; e.preventDefault(); autoFit = false;
  vp = zoomAt(vp, local(e), e.deltaY < 0 ? 1.15 : 1 / 1.15); draw();
}, { passive: false });

// ---------- keyboard (full alternative to the mouse)
canvas.addEventListener("focus", () => { if (img && !cursor) cursor = { x: img.naturalWidth / 2, y: img.naturalHeight / 2 }; cursorVisible = !!cursor; draw(); });
canvas.addEventListener("blur", () => { cursorVisible = false; draw(); });
canvas.addEventListener("keydown", (e) => {
  if (!img || !vp) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key;
  const step = (e.shiftKey ? 40 : 4) / vp.scale;
  let handled = true;
  if (k === "ArrowLeft") cursor = { ...cursor, x: cursor.x - step };
  else if (k === "ArrowRight") cursor = { ...cursor, x: cursor.x + step };
  else if (k === "ArrowUp") cursor = { ...cursor, y: cursor.y - step };
  else if (k === "ArrowDown") cursor = { ...cursor, y: cursor.y + step };
  else if (k === "Enter" || k === " ") { overrideMsg = null; ed.click(cursor); }
  else if (k === "f" || k === "F") { overrideMsg = null; ed.finish(); }
  else if (k === "Backspace") { overrideMsg = null; ed.removeLastDraftPoint(); }
  else if (k === "Escape") { overrideMsg = null; ed.cancel(); }
  else if (mod && (k === "z" || k === "Z") && !e.shiftKey) ed.undo();
  else if (mod && (k === "y" || k === "Y" || ((k === "z" || k === "Z") && e.shiftKey))) ed.redo();
  else if (k === "+" || k === "=") { zoomCentre(1.25); }
  else if (k === "-") { zoomCentre(1 / 1.25); }
  else if (k === "0") { autoFit = true; fit(); }
  else handled = false;
  if (!handled) return;
  e.preventDefault();
  if (cursor) { // keep the crosshair on the image and on screen
    cursor = { x: Math.min(img.naturalWidth, Math.max(0, cursor.x)), y: Math.min(img.naturalHeight, Math.max(0, cursor.y)) };
    const s = imageToScreen(cursor, vp), m = 24;
    if (s.x < m || s.y < m || s.x > canvas.clientWidth - m || s.y > canvas.clientHeight - m)
      vp = panBy(vp, Math.max(0, m - s.x) - Math.max(0, s.x - (canvas.clientWidth - m)), Math.max(0, m - s.y) - Math.max(0, s.y - (canvas.clientHeight - m)));
  }
  refresh();
});

// ---------- drawing
function draw() {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!img || !vp) {
    ctx.fillStyle = css("--muted"); ctx.font = "16px system-ui"; ctx.textAlign = "center";
    ctx.fillText("Drop a PNG or JPEG floor plan here, or use Choose a PNG or JPEG floor plan.", w / 2, h / 2);
    return;
  }
  ctx.drawImage(img, vp.tx, vp.ty, img.naturalWidth * vp.scale, img.naturalHeight * vp.scale);
  const snap = ed.snapshot(), plan = snap.plan, S = (p) => imageToScreen(p, vp);
  const trace = (pts, close) => { ctx.beginPath(); pts.forEach((p, i) => { const s = S(p); i ? ctx.lineTo(s.x, s.y) : ctx.moveTo(s.x, s.y); }); if (close) ctx.closePath(); };
  const label = (text, pts, color) => {
    const c = pts.reduce((a, p) => ({ x: a.x + p.x / pts.length, y: a.y + p.y / pts.length }), { x: 0, y: 0 }), s = S(c);
    ctx.font = "13px system-ui"; ctx.textAlign = "center"; ctx.lineWidth = 3; ctx.strokeStyle = css("--panel"); ctx.strokeText(text, s.x, s.y); ctx.fillStyle = color; ctx.fillText(text, s.x, s.y);
  };
  const dot = (p, r, color) => { const s = S(p); ctx.fillStyle = color; ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fill(); };

  if (plan.boundary) { trace(plan.boundary, true); ctx.fillStyle = css("--c-boundary") + "1F"; ctx.fill(); ctx.setLineDash([]); ctx.lineWidth = 2.5; ctx.strokeStyle = css("--c-boundary"); ctx.stroke(); }
  for (const z of plan.zones) {
    const col = css("--c-" + z.zone_type);
    trace(z.vertices, true); ctx.fillStyle = col + "33"; ctx.fill();
    ctx.setLineDash(z.zone_type === "crowd" ? [2, 4] : z.zone_type === "restricted" ? [8, 5] : z.zone_type === "priority" ? [12, 3, 2, 3] : []);
    ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke(); ctx.setLineDash([]);
    label(`${z.name} (${z.zone_type})`, z.vertices, col);
  }
  for (const o of plan.obstacles) { trace(o.vertices, true); ctx.fillStyle = css("--c-obstacle") + "44"; ctx.fill(); ctx.setLineDash([6, 4]); ctx.lineWidth = 2; ctx.strokeStyle = css("--c-obstacle"); ctx.stroke(); ctx.setLineDash([]); }
  ctx.lineWidth = 3; ctx.strokeStyle = css("--c-wall"); ctx.lineCap = "round";
  for (const wl of plan.walls) { trace([wl.a, wl.b], false); ctx.stroke(); }
  const ov = overlay();
  if (ov && $("show-cov").checked) {
    const { problem, planJson, result, counts } = ov, res = problem.grid.resolution_m;
    const origin = planJson.transform.origin_px, mpp = planJson.scale.metres_per_px;
    const toS = (x, y) => S(metresToImagePx({ x, y }, origin, mpp));
    const hatch = document.createElement("canvas"); hatch.width = hatch.height = 8;
    const hg = hatch.getContext("2d"); hg.strokeStyle = css("--bad"); hg.lineWidth = 1.5; hg.beginPath(); hg.moveTo(0, 8); hg.lineTo(8, 0); hg.stroke();
    const ok = new Path2D(), bad = new Path2D();
    for (let k = 0; k < problem.N; k++) {
      const q = problem.centre(k), a = toS(q.x - res / 2, q.y - res / 2), b = toS(q.x + res / 2, q.y + res / 2);
      (counts[k] >= problem.required[k] ? ok : bad).rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    }
    ctx.fillStyle = css("--accent") + "26"; ctx.fill(ok);
    ctx.fillStyle = ctx.createPattern(hatch, "repeat"); ctx.fill(bad);
    for (const an of result.anchors) {
      const s = toS(an.x_m, an.y_m);
      ctx.beginPath(); ctx.moveTo(s.x, s.y - 8); ctx.lineTo(s.x + 8, s.y); ctx.lineTo(s.x, s.y + 8); ctx.lineTo(s.x - 8, s.y); ctx.closePath();
      ctx.fillStyle = css("--ink"); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = css("--panel"); ctx.stroke();
      ctx.font = "12px system-ui"; ctx.textAlign = "left"; ctx.lineWidth = 3; ctx.strokeStyle = css("--panel"); ctx.strokeText("A" + an.anchor_id, s.x + 10, s.y - 8); ctx.fillStyle = css("--ink"); ctx.fillText("A" + an.anchor_id, s.x + 10, s.y - 8);
    }
    const w = toS(result.coverage.worst_case.x_m, result.coverage.worst_case.y_m);
    ctx.lineWidth = 2; ctx.strokeStyle = css("--bad"); ctx.beginPath(); ctx.arc(w.x, w.y, 9, 0, Math.PI * 2); ctx.moveTo(w.x - 6, w.y - 6); ctx.lineTo(w.x + 6, w.y + 6); ctx.moveTo(w.x + 6, w.y - 6); ctx.lineTo(w.x - 6, w.y + 6); ctx.stroke();
  }
  const c = plan.calibration;
  if (c.a) {
    if (c.b) { trace([c.a, c.b], false); ctx.setLineDash([4, 3]); ctx.lineWidth = 2; ctx.strokeStyle = css("--ink"); ctx.stroke(); ctx.setLineDash([]); dot(c.b, 5, css("--ink")); label(c.known_m ? `${c.known_m} m` : "scale", [c.a, c.b], css("--ink")); }
    dot(c.a, 5, css("--ink"));
  }
  if (snap.draft.length) {
    const pts = cursorVisible && cursor ? [...snap.draft, cursor] : snap.draft;
    trace(pts, false); ctx.setLineDash([5, 4]); ctx.lineWidth = 2; ctx.strokeStyle = css("--accent"); ctx.stroke(); ctx.setLineDash([]);
    snap.draft.forEach((p) => dot(p, 4, css("--accent")));
  }
  if (cursorVisible && cursor) {
    const s = S(cursor); ctx.lineWidth = 1.5; ctx.strokeStyle = css("--ink"); ctx.beginPath();
    ctx.moveTo(s.x - 9, s.y); ctx.lineTo(s.x + 9, s.y); ctx.moveTo(s.x, s.y - 9); ctx.lineTo(s.x, s.y + 9); ctx.stroke();
  }
}

// ---------- panels
function refresh(syncKnown = true) {
  const snap = ed.snapshot(), plan = snap.plan, v = validatePlan(plan);
  if (cov && cov.plan !== plan) { cov = null; setRun("The plan changed, so the earlier coverage result was cleared. Run the search again."); }
  if (crowdCmp && crowdCmp.plan !== plan) { crowdCmp = null; setCrowd("The plan changed, so the earlier crowd comparison was cleared. Run it again."); }
  for (const b of toolsEl.children) { b.setAttribute("aria-pressed", String(b.dataset.tool === snap.tool)); b.disabled = !plan.image; }
  const zoneTool = snap.tool === "zone" || snap.tool === "crowd_circle", wallTool = snap.tool === "wall";
  $("opt-wall").hidden = !wallTool; $("opt-zone").hidden = !zoneTool; $("opt-none").hidden = wallTool || zoneTool;
  $("zonetype").disabled = snap.tool === "crowd_circle";
  if (snap.tool === "crowd_circle") $("zonetype").value = "crowd"; else $("zonetype").value = snap.options.zone_type;
  $("opt-density").hidden = !(snap.tool === "crowd_circle" || snap.options.zone_type === "crowd");
  $("message").textContent = overrideMsg ?? snap.message;
  const polygonTool = ["boundary", "obstacle", "zone"].includes(snap.tool);
  $("finish").disabled = !(polygonTool && snap.draft.length >= 3);
  $("cancel").disabled = snap.draft.length === 0;
  $("undo").disabled = !snap.canUndo; $("redo").disabled = !snap.canRedo; $("reset").disabled = !plan.image;
  $("export-plan").disabled = $("export-venue").disabled = v.errors.length > 0;
  if (syncKnown && document.activeElement !== $("known")) $("known").value = plan.calibration.known_m ?? "";

  $("scale-readout").textContent = v.metres_per_px
    ? `1 pixel = ${v.metres_per_px.toFixed(4)} m (${(1 / v.metres_per_px).toFixed(1)} px per metre).` + (v.width_m ? ` Traced area: ${v.width_m.toFixed(1)} x ${v.height_m.toFixed(1)} m.` : "")
    : "Scale not set yet.";

  const items = [];
  const row = (text, kind, id) => { const e = document.createElement("li"); const s = document.createElement("span"); s.textContent = text;
    const b = document.createElement("button"); b.type = "button"; b.textContent = "Delete"; b.dataset.kind = kind; b.dataset.id = id; b.setAttribute("aria-label", `Delete ${text}`); e.append(s, b); items.push(e); };
  if (plan.boundary) row("Floor boundary", "boundary", "boundary");
  plan.walls.forEach((w) => row(`${w.wall_id} (${w.material})`, "wall", w.wall_id));
  plan.obstacles.forEach((o) => row(o.obstacle_id, "obstacle", o.obstacle_id));
  plan.zones.forEach((z) => row(`${z.name} (${z.zone_type})`, "zone", z.zone_id));
  if (!items.length) { const e = document.createElement("li"); e.textContent = "Nothing traced yet."; items.push(e); }
  $("items").replaceChildren(...items);

  const probs = [...v.errors.map((m) => li("err", "Problem: " + m)), ...v.warnings.map((m) => li("warn", "Warning: " + m))];
  if (!probs.length) probs.push(li("ok", "No problems found. The plan can be exported."));
  $("problems").replaceChildren(...probs);
  const range = num("range");
  $("run").disabled = running || v.errors.length > 0 || !(range > 0);
  $("run").setAttribute("title", v.errors.length ? "Fix the problems under Checks first." : !(range > 0) ? "Enter the assumed maximum range first." : "");
  $("export-report").disabled = $("export-anchors").disabled = !cov;
  $("export-venue-anchors").disabled = !cov || cov.result.exceeds_model_slots || cov.result.k === 0;
  renderCoverage();
  const cr = !!crowdCmp;
  $("c-run").disabled = running || v.errors.length > 0 || !(range > 0);
  $("c-run").setAttribute("title", v.errors.length ? "Fix the problems under Checks first." : !(range > 0) ? "Enter the assumed maximum range first." : "");
  $("c-view").disabled = !cr; $("c-export-report").disabled = $("c-export-regions").disabled = $("c-export-anchors").disabled = !cr;
  if (optRun && optRun.plan !== plan) { optRun = null; setOpt("The plan changed, so the earlier ranking was cleared. Run it again."); }
  $("o-run").disabled = running || v.errors.length > 0 || !(range > 0);
  $("o-run").setAttribute("title", v.errors.length ? "Fix the problems under Checks first." : !(range > 0) ? "Enter the assumed maximum range first." : "");
  renderOptimizer();
  renderCrowd();
  draw();
}
$("range").addEventListener("input", () => refresh(false));
refresh();
