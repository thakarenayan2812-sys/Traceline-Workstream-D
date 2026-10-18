import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildCoverageProblem, lowerBound, evaluateLayout, naiveGridLayout, naiveMinAnchors, venueWithAnchors, layoutCounts } from "../src/plan/coverage.js";
import { searchMinimumAnchors, LABELS } from "../src/plan/search.js";
import { buildCoverageReport, anchorsCsv, SITE_SURVEY_WARNING } from "../src/plan/coverage_report.js";
import { planFromJson, toVenue } from "../src/plan/plan_export.js";
import { lineOfSight, distance, distancePointSegment } from "../src/core/geometry.js";
import { validateVenue } from "../src/core/validate.js";
import { sha256Hex, canonicalJson } from "../src/plan/hash.js";

const fx = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const room = (w, h, walls = []) => ({ schema_version: "1.0", venue_id: "custom", width_m: w, height_m: h, anchors: [], walls, obstacles: [], zones: [], metadata: {} });
const wall = (id, x1, y1, x2, y2) => ({ wall_id: id, x1_m: x1, y1_m: y1, x2_m: x2, y2_m: y2, material: "drywall" });

/** Independent check: count anchors per cell centre straight from geometry, not from the search's lists. */
function independentlyCovered(p, result) {
  const a = result.anchors.map((q) => ({ x: q.x_m, y: q.y_m }));
  for (let c = 0; c < p.N; c++) {
    const ctr = p.centre(c);
    const n = a.filter((q) => distance(q, ctr) <= p.options.max_range_m && !lineOfSight(q, ctr, p.venue).blocked).length;
    if (n < p.required[c]) return false;
  }
  return true;
}

test("open room: 3 anchors suffice and are proven minimal", async () => {
  const p = buildCoverageProblem(room(10, 10), { max_range_m: 30 });
  const r = await searchMinimumAnchors(p, { seed: 1 });
  assert.equal(r.status, "met"); assert.equal(r.k, 3); assert.equal(r.lower_bound, 3);
  assert.ok(r.proven); assert.equal(r.label, LABELS.proven);
  assert.equal(r.coverage.uncovered_cells, 0);
  assert.ok(independentlyCovered(p, r));
});

test("two rooms behind a full wall need 3 anchors each", async () => {
  const p = buildCoverageProblem(room(20, 10, [wall("w", 10, 0, 10, 10)]), { max_range_m: 40 });
  const r = await searchMinimumAnchors(p, { seed: 1 });
  assert.equal(r.k, 6); assert.equal(r.lower_bound, 6); assert.ok(r.proven);
  assert.ok(independentlyCovered(p, r));
  const left = r.anchors.filter((a) => a.x_m < 10).length;
  assert.equal(left, 3);
});

test("range-limited corridor: the layout really covers every cell (independent check)", async () => {
  const p = buildCoverageProblem(room(40, 4), { max_range_m: 8 });
  const r = await searchMinimumAnchors(p, { seed: 3, budget: 30000 });
  assert.equal(r.status, "met"); assert.ok(r.k >= r.lower_bound);
  assert.ok(independentlyCovered(p, r));
});

test("every met result on a walled floor passes the independent check, for several seeds and ranges", async () => {
  const venue = room(30, 20, [wall("a", 10, 0, 10, 14), wall("b", 20, 6, 20, 20)]);
  for (const [seed, range] of [[1, 12], [2, 15], [9, 20]]) {
    const p = buildCoverageProblem(venue, { max_range_m: range });
    const r = await searchMinimumAnchors(p, { seed });
    assert.equal(r.status, "met");
    assert.ok(independentlyCovered(p, r), `seed ${seed} range ${range}`);
    assert.ok(r.k >= r.lower_bound);
  }
});

test("lower bound never exceeds the brute-force minimum on a tiny instance, and search finds it", async () => {
  const venue = room(12, 6, [wall("w", 6, 0, 6, 4)]);
  const p = buildCoverageProblem(venue, { max_range_m: 9, candidate_spacing_m: 4, resolution_m: 1.5 });
  const M = p.candidates.length;
  assert.ok(M <= 14, `brute force needs a small candidate set, got ${M}`);
  let bestK = Infinity;
  for (let mask = 1; mask < 1 << M; mask++) {
    const layout = []; for (let j = 0; j < M; j++) if (mask & (1 << j)) layout.push(j);
    if (layout.length < bestK && evaluateLayout(p, layout).criterion_met) bestK = layout.length;
  }
  assert.ok(Number.isFinite(bestK));
  assert.ok(lowerBound(p) <= bestK);
  const r = await searchMinimumAnchors(p, { seed: 1, budget: 50000 });
  assert.equal(r.k, bestK);
});

test("determinism: same inputs and seed give identical results", async () => {
  const p = buildCoverageProblem(room(30, 20, [wall("a", 10, 0, 10, 14)]), { max_range_m: 14 });
  const a = await searchMinimumAnchors(p, { seed: 7, budget: 8000 });
  const b = await searchMinimumAnchors(p, { seed: 7, budget: 8000 });
  assert.deepEqual(a, b);
});

test("budget is a hard cap; too small a budget is reported as not met, never as success", async () => {
  const p = buildCoverageProblem(room(30, 20, [wall("a", 10, 0, 10, 14)]), { max_range_m: 10 });
  const r = await searchMinimumAnchors(p, { seed: 1, budget: 50 });
  assert.ok(r.search.evaluations_used <= 50);
  assert.equal(r.status, "not_met"); assert.equal(r.reason, "budget"); assert.equal(r.proven, false);
  assert.equal(r.label, LABELS.not_met);
  const big = await searchMinimumAnchors(p, { seed: 1, budget: 30000 });
  assert.ok(big.search.evaluations_used <= 30000);
});

test("max_anchors limit is honoured and reported", async () => {
  const p = buildCoverageProblem(room(40, 4), { max_range_m: 5 });
  const r = await searchMinimumAnchors(p, { seed: 1, budget: 30000, max_anchors: 4 });
  assert.equal(r.status, "not_met"); assert.equal(r.reason, "max_anchors"); assert.ok(r.k <= 4);
});

test("a sealed closet with no candidate inside is infeasible and says so", async () => {
  const venue = room(20, 20, [wall("n", 0, 3, 3, 3), wall("e", 3, 0, 3, 3)]);   // 3x3 closet in the corner
  const p = buildCoverageProblem(venue, { max_range_m: 50, candidate_spacing_m: 8 });
  assert.ok(p.infeasible > 0);
  const r = await searchMinimumAnchors(p, { seed: 1 });
  assert.equal(r.status, "not_met"); assert.equal(r.reason, "infeasible_cells");
  assert.ok(r.infeasible.fraction > 0);
});

test("proven is true only when k equals the lower bound", async () => {
  const p = buildCoverageProblem(room(30, 20, [wall("a", 10, 0, 10, 14), wall("b", 20, 6, 20, 20)]), { max_range_m: 15 });
  const r = await searchMinimumAnchors(p, { seed: 1 });
  assert.equal(r.proven, r.k === r.lower_bound);
  assert.equal(r.label, r.proven ? LABELS.proven : LABELS.best_found);
});

test("candidates respect wall clearance, bounds, obstacles and zone exclusion", () => {
  const venue = { ...room(20, 20, [wall("w", 10, 0, 10, 20)]), obstacles: [{ obstacle_id: "o", vertices: [[2, 2], [6, 2], [6, 6], [2, 6]] }],
    zones: [{ zone_id: "r", zone_type: "restricted", polygon: [[14, 14], [20, 14], [20, 20], [14, 20]] }] };
  const p = buildCoverageProblem(venue, { max_range_m: 10, candidate_spacing_m: 1, mounting: { exclude_zone_types: ["restricted"] } });
  for (const q of p.candidates) {
    assert.ok(q.x >= 0 && q.x <= 20 && q.y >= 0 && q.y <= 20);
    assert.ok(distancePointSegment(q, { x: 10, y: 0 }, { x: 10, y: 20 }) >= 0.2);
    assert.ok(!(q.x > 2 && q.x < 6 && q.y > 2 && q.y < 6));
    assert.ok(!(q.x >= 14 && q.y >= 14));
  }
});

test("wall-mounted mode puts candidates beside walls, on both sides, never on them", () => {
  const venue = room(20, 10, [wall("w", 10, 0, 10, 10)]);
  const p = buildCoverageProblem(venue, { max_range_m: 10, mounting: { mode: "wall_mounted" } });
  const nearWall = p.candidates.filter((q) => Math.abs(q.x - 10) < 0.5);
  assert.ok(nearWall.some((q) => q.x < 10) && nearWall.some((q) => q.x > 10));
  assert.ok(p.candidates.every((q) => distancePointSegment(q, { x: 10, y: 0 }, { x: 10, y: 10 }) >= 0.2 - 1e-9));
});

test("naive grid: distinct snapped candidates, and it is compared on the same criterion", () => {
  const p = buildCoverageProblem(room(30, 20, [wall("a", 10, 0, 10, 14)]), { max_range_m: 14 });
  const layout = naiveGridLayout(p, 9);
  assert.equal(new Set(layout).size, 9);
  const m = naiveMinAnchors(p, 40);
  assert.ok(m === null || m >= lowerBound(p));
});

test("per-cell requirement hook (used by crowd-aware planning) raises the anchor count", async () => {
  const venue = room(20, 10);
  const base = await searchMinimumAnchors(buildCoverageProblem(venue, { max_range_m: 30 }), { seed: 1 });
  const strict = buildCoverageProblem(venue, { max_range_m: 30, required_per_cell: (c) => (c.x < 10 ? 5 : 3) });
  const r = await searchMinimumAnchors(strict, { seed: 1 });
  assert.equal(base.k, 3); assert.equal(r.k, 5);
  assert.ok(independentlyCovered(strict, r));
  const counts = layoutCounts(strict, r._layout);
  for (let c = 0; c < strict.N; c++) assert.ok(counts[c] >= strict.required[c]);
});

test("input validation gives clear errors", () => {
  for (const bad of [0, -3, NaN, undefined]) assert.throws(() => buildCoverageProblem(room(10, 10), { max_range_m: bad }), /Maximum range/);
  assert.throws(() => buildCoverageProblem(room(10, 10), { max_range_m: 10, resolution_m: 0 }), /resolution/);
  assert.throws(() => buildCoverageProblem(room(10, 10), { max_range_m: 10, max_pairs: 10 }), /coarser grid/);
  const p = buildCoverageProblem(room(10, 10), { max_range_m: 10 });
  return Promise.all([
    assert.rejects(searchMinimumAnchors(p, { budget: 0 }), /budget/),
    assert.rejects(searchMinimumAnchors(p, { max_anchors: 0 }), /Maximum anchors/),
  ]);
});

test("venueWithAnchors honours the 8-slot model contract", () => {
  const v = room(10, 10);
  const ok = venueWithAnchors(v, [{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 5, y: 9 }]);
  assert.deepEqual(ok.anchors.map((a) => a.anchor_id), [0, 1, 2]);
  assert.deepEqual(validateVenue(ok), []);
  assert.throws(() => venueWithAnchors(v, Array.from({ length: 9 }, (_, i) => ({ x: i, y: 1 }))), /at most 8/);
});

test("report: manifest, assumptions, site-survey warning, stable config hash, CSV format", async () => {
  const saved = JSON.parse(readFileSync(join(fx, "sample_plan.json"), "utf8"));
  const venue = toVenue(planFromJson(saved), { created_at: saved.created_at });
  const p = buildCoverageProblem(venue, { max_range_m: 20 });
  const r = await searchMinimumAnchors(p, { seed: 2, budget: 15000 });
  const rep = await buildCoverageReport({ result: r, problem: p, planJson: saved, created_at: "2026-10-18T00:00:00.000Z" });
  assert.equal(rep.manifest.seed, 2); assert.match(rep.manifest.config_hash, /^[0-9a-f]{64}$/);
  assert.ok(rep.warnings.includes(SITE_SURVEY_WARNING));
  assert.ok(rep.assumptions.some((a) => /within 20 m/.test(a)) && rep.assumptions.some((a) => /centre only/.test(a)));
  assert.ok(!("_layout" in rep.result));
  const rep2 = await buildCoverageReport({ result: r, problem: p, planJson: saved, created_at: "2026-10-18T00:00:00.000Z" });
  assert.deepEqual(rep2, rep);
  const csv = anchorsCsv(r);
  assert.ok(csv.startsWith("anchor_id,x_m,y_m\n") && csv.endsWith("\n") && !csv.includes("\r"));
  assert.match(csv.split("\n")[1], /^0,\d+\.\d{3},\d+\.\d{3}$/);
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test("saved example report matches a fresh re-run of the same command", async () => {
  const saved = JSON.parse(readFileSync(join(fx, "sample_plan.json"), "utf8"));
  const example = JSON.parse(readFileSync(join(fx, "sample_coverage.report.json"), "utf8"));
  const venue = toVenue(planFromJson(saved), { created_at: saved.created_at });
  const p = buildCoverageProblem(venue, { max_range_m: 15 });
  const r = await searchMinimumAnchors(p, { seed: 1, budget: 20000 });
  assert.equal(r.k, example.result.k);
  assert.deepEqual(r.anchors, example.result.anchors);
  assert.ok(independentlyCovered(p, r));
});

test("async yielding does not change results", async () => {
  const p = buildCoverageProblem(room(30, 20, [wall("a", 10, 0, 10, 14)]), { max_range_m: 14 });
  let yields = 0;
  const a = await searchMinimumAnchors(p, { seed: 4, budget: 6000, yieldEvery: 100, yieldFn: async () => { yields++; } });
  const b = await searchMinimumAnchors(p, { seed: 4, budget: 6000 });
  assert.ok(yields > 0); assert.deepEqual(a, b);
});

test("shouldStop ends the search early and is reported", async () => {
  const p = buildCoverageProblem(room(30, 20, [wall("a", 10, 0, 10, 14)]), { max_range_m: 10 });
  const r = await searchMinimumAnchors(p, { seed: 1, budget: 30000, yieldEvery: 50, yieldFn: async () => {}, shouldStop: () => true });
  assert.equal(r.search.stopped, true);
  assert.ok(r.search.evaluations_used < 30000);
});
