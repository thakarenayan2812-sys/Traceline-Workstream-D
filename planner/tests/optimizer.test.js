// D6: anchor placement optimizer, stand-in simulator, error statistics, ranking. Small synthetic rooms keep these fast.
import test from "node:test";
import assert from "node:assert/strict";
import { DT_S, MAX_ANCHOR_SLOTS } from "../src/core/constants.js";
import { lineOfSight } from "../src/core/geometry.js";
import { percentile, errorStats, chooseSlots, scoreLayout, runAnchorOptimizer } from "../src/plan/optimizer.js";
import { makeEvaluationSet, simulateReadings, walkableCentres, STAND_IN_CROWD_EFFECTS } from "../src/adapters/simulator_adapter.js";
import { createMockPredictor, buildModelInput } from "../src/adapters/inference_adapter.js";
import { buildOptimizerReport, rankingCsv, layoutAnchorsCsv } from "../src/plan/optimizer_report.js";
import { buildCoverageProblem } from "../src/plan/coverage.js";

const room = (extra = {}) => ({ schema_version: "1.0", venue_id: "custom", width_m: 12, height_m: 8, anchors: [], walls: [], obstacles: [], zones: [], metadata: {}, ...extra });
const walled = () => room({ walls: [{ wall_id: "w1", x1_m: 6, y1_m: 0, x2_m: 6, y2_m: 8, material: "brick" }] });
const fast = { max_range_m: 9, resolution_m: 1, candidate_spacing_m: 2, seed: 1, budget: 3000, search_seeds: 2, extension_levels: 1,
  max_anchors: 20, trajectories: 1, steps: 60 };

test("percentiles use linear interpolation and the error statistics are right", () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.ok(Math.abs(percentile([1, 2, 3, 4], 0.9) - 3.7) < 1e-12);
  const s = errorStats([1, 2, 3, 4]);
  assert.equal(s.steps, 4); assert.equal(s.median_m, 2.5); assert.equal(s.mean_m, 2.5); assert.equal(s.p90_m, 3.7);
  assert.equal(s.rmse_m, 2.7386);
  assert.deepEqual(errorStats([]).median_m, null);
});

test("with more than 8 anchors the slots go to the 8 smallest measured ranges", () => {
  const layout = Array.from({ length: 10 }, (_, i) => ({ anchor_id: i, x_m: i, y_m: 0, candidate_index: i }));
  const range = new Map(layout.map((a) => [a.anchor_id, 10 - a.anchor_id])); // anchor 9 is nearest
  range.set(0, null); // anchor 0 has no reading
  const chosen = chooseSlots(layout, range).map((a) => a.anchor_id);
  assert.equal(chosen.length, MAX_ANCHOR_SLOTS);
  assert.ok(!chosen.includes(0), "a missing reading must not take a slot while valid ones remain");
  assert.deepEqual(chosen, [2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(chooseSlots(layout.slice(0, 5), range).length, 5, "up to 8 anchors: all used");
});

test("with fewer valid readings than slots, unused slots are padded with anchors that have no reading", () => {
  const layout = Array.from({ length: 10 }, (_, i) => ({ anchor_id: i, x_m: i, y_m: 0, candidate_index: i }));
  const range = new Map([[3, 4.0], [7, 2.0]]);
  const chosen = chooseSlots(layout, range).map((a) => a.anchor_id);
  assert.equal(chosen.length, 8);
  assert.ok(chosen.includes(7) && chosen.includes(3));
});

test("evaluation walks are seeded, stay on walkable cells, never cross a wall, and move at the set speed", () => {
  const v = walled();
  const a = makeEvaluationSet(v, { seed: 5, trajectories: 2, steps: 200, speed_mps: 1.0 });
  const b = makeEvaluationSet(v, { seed: 5, trajectories: 2, steps: 200, speed_mps: 1.0 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(makeEvaluationSet(v, { seed: 6, trajectories: 2, steps: 200 }).trajectories, a.trajectories);
  const cells = new Set(walkableCentres(v, 1).map((c) => `${c.x},${c.y}`));
  for (const { truth } of a.trajectories) {
    assert.ok(cells.has(`${truth[0].x},${truth[0].y}`), "the start is a walkable cell centre");
    truth.forEach((p, k) => {
      assert.ok(p.x >= 0 && p.x <= v.width_m && p.y >= 0 && p.y <= v.height_m, "every position is inside the venue");
      if (k > 0) {
        assert.ok(Math.hypot(p.x - truth[k - 1].x, p.y - truth[k - 1].y) <= 1.0 * DT_S + 1e-9, "one step is at most speed x dt");
        assert.equal(lineOfSight(truth[k - 1], p, v).blocked, false, "a step never crosses a wall");
      }
    });
  }
});

test("simulated readings use null for missing values and are free of sentinels and labels", () => {
  const v = walled();
  const evalSet = makeEvaluationSet(v, { seed: 2, trajectories: 1, steps: 300 });
  const layout = [{ anchor_id: 0, x_m: 2, y_m: 4, candidate_index: 3 }, { anchor_id: 1, x_m: 10, y_m: 2, candidate_index: 8 }];
  const readings = simulateReadings(v, evalSet, layout, { seed: 2 })[0].readings;
  const flat = readings.flat();
  assert.ok(flat.every((r) => Object.keys(r).sort().join() === "anchor_id,range_m,rssi_dbm"), "readings carry only the fields a predictor may use");
  const ranges = flat.map((r) => r.range_m).filter((x) => x != null);
  assert.ok(ranges.length > 0 && ranges.every((x) => Number.isFinite(x) && x >= 0));
  assert.ok(flat.some((r) => r.range_m === null), "packet loss appears as null");
  assert.ok(!ranges.includes(-1) && !ranges.includes(999), "no sentinel values");
});

test("common random numbers: an anchor sees the same noise in every layout that contains it", () => {
  const v = room();
  const evalSet = makeEvaluationSet(v, { seed: 3, trajectories: 1, steps: 40 });
  const a = { anchor_id: 0, x_m: 2, y_m: 2, candidate_index: 5 };
  const b = { anchor_id: 1, x_m: 10, y_m: 6, candidate_index: 9 };
  const solo = simulateReadings(v, evalSet, [a], { seed: 3 })[0].readings;
  const pair = simulateReadings(v, evalSet, [b, a], { seed: 3 })[0].readings;
  solo.forEach((step, k) => {
    const fromSolo = step[0];
    const fromPair = pair[k].find((r) => r.anchor_id === 0);
    assert.deepEqual(fromPair, fromSolo);
  });
});

test("NLOS labels follow the wall between anchor and person, and the bias is positive only when blocked", () => {
  const v = walled();
  const evalSet = { seed: 1, trajectories: [{ traj: 0, truth: [{ x: 9, y: 4 }, { x: 3, y: 4 }] }] };
  const layout = [{ anchor_id: 0, x_m: 2, y_m: 4, candidate_index: 1 }];
  const { labels } = simulateReadings(v, evalSet, layout, { seed: 1 })[0];
  assert.equal(labels[0][0].is_nlos, true, "person behind the wall");
  assert.equal(labels[1][0].is_nlos, false, "person in line of sight");
  assert.ok(labels[0][0].bias_m >= 0.5 && labels[0][0].bias_m <= 3.0);
  assert.equal(labels[1][0].bias_m, 0);
});

test("crowd zones raise packet loss (placeholder effect is monotonic in density)", () => {
  const v = room();
  const polygon = [[0, 0], [12, 0], [12, 8], [0, 8]];
  const truth = Array.from({ length: 800 }, () => ({ x: 6, y: 4 }));
  const evalSet = { seed: 4, trajectories: [{ traj: 0, truth }] };
  const layout = [{ anchor_id: 0, x_m: 1, y_m: 1, candidate_index: 2 }];
  const lost = (zones) => simulateReadings(v, evalSet, layout, { seed: 4, crowdZones: zones })[0].readings.filter((s) => s[0].range_m === null).length;
  const none = lost([]);
  const dense = lost([{ zone_id: "z", polygon, density_people_m2: 4 }]);
  assert.ok(dense > none, `expected more losses in a dense crowd (${dense} vs ${none})`);
  assert.ok(STAND_IN_CROWD_EFFECTS.max_loss >= 0.13, "the cap leaves room for the density effect");
});

test("the predictor sees only measurement inputs: no truth, no NLOS labels, exactly 8 slots", async () => {
  const v = walled();
  const evalSet = makeEvaluationSet(v, { seed: 7, trajectories: 1, steps: 40 });
  const layout = Array.from({ length: 10 }, (_, i) => ({ anchor_id: i, x_m: 1 + i, y_m: 1 + (i % 3) * 2, candidate_index: i + 1 }));
  const seen = [];
  const predictor = { name: "spy", is_mock: true, reset() {}, async predict(input) {
    seen.push(input);
    return createMockPredictor().predict(input);
  } };
  await scoreLayout(v, layout, evalSet, { predictor });
  assert.equal(seen.length, 40);
  const allowedSlot = new Set(["anchor_id", "x_m", "y_m", "range_m", "rssi_dbm", "valid_flag"]);
  for (const input of seen) {
    assert.equal(input.slots.length, MAX_ANCHOR_SLOTS);
    assert.deepEqual(Object.keys(input).sort(), ["dt_s", "previous_position_valid", "slots", "state", "x_prev_m", "y_prev_m"].sort());
    for (const s of input.slots) assert.ok(Object.keys(s).every((k) => allowedSlot.has(k)), `unexpected slot field in ${Object.keys(s)}`);
  }
  // The same readings give the same input, with or without labels, so labels cannot reach the model.
  const sim = simulateReadings(v, evalSet, layout, { seed: evalSet.seed })[0];
  const feedOnly = sim.readings[0].filter((r) => r.range_m != null);
  assert.ok(feedOnly.every((r) => !("is_nlos" in r) && !("bias_m" in r)));
  const direct = buildModelInput({ anchors: layout.slice(0, 8).map((a) => ({ ...a, enabled: true })) }, feedOnly, null, DT_S, null);
  assert.equal(direct.slots.length, MAX_ANCHOR_SLOTS);
});

test("optimizer returns a deterministic, ranked and Pareto-consistent result on a small room", async () => {
  const v = room();
  const r1 = await runAnchorOptimizer(v, fast);
  const r2 = await runAnchorOptimizer(v, fast);
  assert.deepEqual(r1, r2, "same inputs, same output");
  assert.equal(r1.status, "ok");
  assert.ok(r1.ranking.length >= 2);
  const byId = new Map(r1.layouts.map((L) => [L.layout_id, L]));
  const ranked = r1.ranking.map((id) => byId.get(id));
  for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].objective_m <= ranked[i].objective_m, "ranked by objective, low to high");
  ranked.forEach((L, i) => { assert.equal(L.rank, i + 1); assert.equal(L.coverage.criterion_met, true); });
  for (const L of r1.layouts) if (!L.coverage.criterion_met || L.source === "naive_grid") assert.equal(L.rank, null);
  assert.equal(r1.best, ranked[0].layout_id);
  // Pareto: a point is on the front exactly when no ranked layout is at least as good on both anchors and P90, and better on one.
  for (const L of ranked) {
    const dominated = ranked.some((M) => M !== L && M.k <= L.k && M.simulated.p90_m <= L.simulated.p90_m && (M.k < L.k || M.simulated.p90_m < L.simulated.p90_m));
    assert.equal(L.pareto_optimal, !dominated, `${L.layout_id} Pareto flag`);
  }
});

test("every ranked anchor count has a naive grid comparison, and the naive grid is never ranked", async () => {
  const r = await runAnchorOptimizer(room(), fast);
  const ks = new Set(r.naive_comparison.map((row) => row.k));
  for (const id of r.ranking) assert.ok(ks.has(r.layouts.find((L) => L.layout_id === id).k));
  assert.ok(r.layouts.filter((L) => L.source === "naive_grid").length >= 1);
  assert.ok(r.naive_comparison.every((row) => row.naive_minus_optimised_p90_m === null || Math.abs(row.naive_minus_optimised_p90_m - (row.naive_p90_m - row.optimised_p90_m)) < 1e-3));
});

test("a larger cost per anchor never picks a layout with more anchors (exact for a linear objective)", async () => {
  const v = room();
  const free = await runAnchorOptimizer(v, fast);
  const costly = await runAnchorOptimizer(v, { ...fast, anchor_cost_m: 0.4 });
  const kOf = (r) => r.layouts.find((L) => L.layout_id === r.best).k;
  assert.ok(kOf(costly) <= kOf(free));
  assert.equal(costly.objective.anchor_cost_m, 0.4);
  await assert.rejects(runAnchorOptimizer(v, { ...fast, anchor_cost_m: -1 }), RangeError);
});

test("without crowd zones the result is judged plainly and reports no crowd statistics", async () => {
  const r = await runAnchorOptimizer(room(), fast);
  assert.equal(r.judged_by, "plain");
  assert.equal(r.simulator.crowd_zones_used, 0);
  assert.ok(r.layouts.every((L) => L.simulated.inside_crowd === null));
});

test("a crowd zone without a density stops with the plain-words error, not a guess", async () => {
  const v = room({ zones: [{ zone_id: "z1", zone_type: "crowd", polygon: [[0, 0], [4, 0], [4, 4], [0, 4]] }] });
  await assert.rejects(runAnchorOptimizer(v, fast), /has no density/);
  const ok = await runAnchorOptimizer(v, { ...fast, fallback_density: 2 });
  assert.equal(ok.judged_by, "crowd_aware");
  assert.ok(ok.warnings.some((w) => /fallback density/.test(w)));
});

test("when no layout meets the criterion the result says so and gives no ranking", async () => {
  const r = await runAnchorOptimizer(room(), { ...fast, max_range_m: 1.2, max_anchors: 2, search_seeds: 1 });
  assert.equal(r.status, "no_layout_meets_criterion");
  assert.equal(r.best, null);
  assert.deepEqual(r.ranking, []);
});

test("the report carries a manifest, the assumptions, and CSVs that match the layouts", async () => {
  const r = await runAnchorOptimizer(room(), fast);
  const rep = await buildOptimizerReport({ result: r, created_at: "2026-01-01T00:00:00.000Z" });
  assert.equal(rep.report_kind, "anchor_placement_optimizer");
  assert.match(rep.manifest.config_hash, /^[0-9a-f]{64}$/);
  assert.equal(rep.manifest.seed, 1);
  assert.ok(rep.assumptions.some((s) => /stand-in simulator/.test(s)));
  assert.ok(rep.warnings[0].length > 0 && rep.warnings.some((w) => /not Traceline results/.test(w)));
  const rows = rankingCsv(r).trim().split("\n");
  assert.equal(rows.length - 1, r.layouts.length, "one row per layout");
  const best = r.layouts.find((L) => L.layout_id === r.best);
  const anchors = layoutAnchorsCsv(r, r.best).trim().split("\n");
  assert.equal(anchors.length - 1, best.k);
  assert.throws(() => layoutAnchorsCsv(r, "L99"), RangeError);
});

test("the coverage problem and the simulator agree on the walkable cells", () => {
  const v = walled();
  const p = buildCoverageProblem(v, { max_range_m: 9, resolution_m: 1, candidate_spacing_m: 2 });
  assert.equal(walkableCentres(v, 1).length, p.N);
});
