import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveCrowdModel, rangeFactor, extraAnchors, crowdZonesFromVenue, stripCrowdZones, buildCrowdField, crowdOptions, DEFAULT_CROWD_MODEL } from "../src/plan/crowd.js";
import { compareCrowd, buildCrowdComparisonReport, crowdComparisonCsv, crowdAnchorsCsv } from "../src/plan/crowd_compare.js";
import { buildCoverageProblem, evaluateLayout, layoutCounts } from "../src/plan/coverage.js";
import { searchMinimumAnchors } from "../src/plan/search.js";
import { planFromJson, toVenue } from "../src/plan/plan_export.js";
import { distance, lineOfSight } from "../src/core/geometry.js";

const fx = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const sq = (x1, y1, x2, y2) => [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
const room = (w, h, zones = [], dens = {}) => ({ schema_version: "1.0", venue_id: "custom", width_m: w, height_m: h, anchors: [], walls: [], obstacles: [], zones,
  metadata: { zone_density_people_m2: dens } });
const crowd = (id, poly) => ({ zone_id: id, zone_type: "crowd", polygon: poly, name: id });
const M = resolveCrowdModel();

test("model: range factor shrinks and extra anchors grow with density, never the other way", () => {
  let pf = 2, pe = -1;
  for (let d = 0; d <= 4.001; d += 0.25) {
    const f = rangeFactor(M, d), e = extraAnchors(M, d);
    assert.ok(f <= pf + 1e-12 && f >= M.min_range_factor); assert.ok(e >= pe && e <= M.max_extra_anchors);
    pf = f; pe = e;
  }
  assert.equal(rangeFactor(M, 0), 1); assert.equal(extraAnchors(M, 0), 0);
  assert.ok(Math.abs(rangeFactor(M, 4) - 0.6) < 1e-12);
  assert.deepEqual([0.1, 2, 2.01, 4].map((d) => extraAnchors(M, d)), [1, 1, 2, 2]);
  assert.equal(rangeFactor({ ...M, min_range_factor: 0.8 }, 4), 0.8);
});

test("model: bad coefficients are refused in plain words", () => {
  for (const bad of [{ range_derate_per_density: -1 }, { min_range_factor: 0 }, { min_range_factor: 1.5 }, { density_per_extra_anchor: 0 }, { max_extra_anchors: 1.5 }, { max_extra_anchors: 9 }])
    assert.throws(() => resolveCrowdModel(bad), RangeError);
  assert.deepEqual(resolveCrowdModel(), DEFAULT_CROWD_MODEL);
});

test("zones: density comes from the venue, fallback only when missing, no silent default", () => {
  const v = room(20, 10, [crowd("a", sq(1, 1, 5, 5)), crowd("b", sq(8, 1, 12, 5)), { zone_id: "r", zone_type: "restricted", polygon: sq(15, 1, 18, 4) }], { a: 3 });
  assert.throws(() => crowdZonesFromVenue(v), /zone b/);
  const z = crowdZonesFromVenue(v, { fallback_density: 1.5 });
  assert.deepEqual(z.map((q) => [q.zone_id, q.density_people_m2, q.density_source]), [["a", 3, "drawn"], ["b", 1.5, "fallback"]]);
  assert.throws(() => crowdZonesFromVenue(v, { fallback_density: 5 }), /between 0 and 4/);
  assert.throws(() => crowdZonesFromVenue(room(5, 5, [crowd("a", sq(1, 1, 2, 2))], { a: -1 })), /between 0 and 4/);
});

test("toVenue records crowd densities in metadata; stripCrowdZones removes zones and densities only", () => {
  const plan = JSON.parse(readFileSync(join(fx, "sample_plan.json"), "utf8"));
  const v0 = toVenue(planFromJson(plan), { created_at: plan.created_at });
  assert.deepEqual(v0.metadata.zone_density_people_m2, {});           // sample circle has no density drawn
  plan.geometry_px.zones[0].density_people_m2 = 2.5;
  plan.geometry.zones_m[0].density_people_m2 = 2.5;
  const v1 = toVenue(planFromJson(plan), { created_at: plan.created_at });
  assert.deepEqual(v1.metadata.zone_density_people_m2, { zone_001: 2.5 });
  const s = stripCrowdZones(v1);
  assert.equal(s.zones.filter((z) => z.zone_type === "crowd").length, 0);
  assert.equal(s.metadata.zone_density_people_m2, undefined);
  assert.deepEqual(s.walls, v1.walls); assert.equal(v1.zones.length, 1);   // original untouched
});

test("field: highest density wins where zones overlap; zero outside; path mean is a plain average", () => {
  const z = [{ zone_id: "a", polygon: sq(0, 0, 6, 10), density_people_m2: 1 }, { zone_id: "b", polygon: sq(4, 0, 10, 10), density_people_m2: 3 }];
  const f = buildCrowdField(room(20, 10), z, 1);
  assert.equal(f.at(2.5, 5.5), 1); assert.equal(f.at(5.5, 5.5), 3); assert.equal(f.at(8.5, 5.5), 3); assert.equal(f.at(15.5, 5.5), 0);
  assert.equal(f.at(-1, 1), 0); assert.equal(f.at(99, 1), 0);
  assert.equal(f.pathMean({ x: 12.5, y: 5.5 }, { x: 19.5, y: 5.5 }), 0);
  assert.equal(f.pathMean({ x: 7.5, y: 5.5 }, { x: 7.5, y: 5.5 }), 3);
  const half = f.pathMean({ x: 7.5, y: 5.5 }, { x: 17.5, y: 5.5 });       // cells 7,8,9 crowded, 10..17 empty
  assert.ok(Math.abs(half - (3 * 3) / 11) < 1e-9, String(half));
});

test("hooks: with no crowd the problem is identical to the D4 problem", async () => {
  const v = room(30, 12), f = buildCrowdField(v, [{ zone_id: "a", polygon: sq(1, 1, 5, 5), density_people_m2: 0 }], 1);
  const p0 = buildCoverageProblem(v, { max_range_m: 12 }), p1 = buildCoverageProblem(v, { max_range_m: 12, ...crowdOptions(f, M) });
  assert.deepEqual(p1.required, p0.required);
  assert.deepEqual(p1.vis.map((a) => [...a]), p0.vis.map((a) => [...a]));
  const r0 = await searchMinimumAnchors(p0, { seed: 4 }), r1 = await searchMinimumAnchors(p1, { seed: 4 });
  assert.deepEqual(r1.anchors, r0.anchors);
});

test("hooks: range really shrinks only along crowded paths, and requirement rises only inside the zone", () => {
  const v = room(30, 10), zone = [{ zone_id: "a", polygon: sq(10, 0, 20, 10), density_people_m2: 4 }];
  const f = buildCrowdField(v, zone, 1), o = { max_range_m: 12, ...crowdOptions(f, M) };
  const p = buildCoverageProblem(v, o);
  for (let c = 0; c < p.N; c++) {
    const q = p.centre(c), inside = q.x > 10 && q.x < 20;
    assert.equal(p.required[c], inside ? 5 : 3);
  }
  // every pair kept by the problem satisfies distance <= range * factor; every dropped, in-range pair does not
  let checked = 0;
  p.candidates.forEach((a, j) => {
    const kept = new Set(p.vis[j]);
    for (let c = 0; c < p.N; c++) {
      const q = p.centre(c), d = distance(a, q);
      if (d > 12 || lineOfSight(a, q, p.venue).blocked) continue;
      const ok = d <= 12 * Math.max(0.5, 1 - 0.1 * f.pathMean(a, q));
      assert.equal(kept.has(c), ok); checked++;
    }
  });
  assert.ok(checked > 1000);
});

test("compare: a crowd zone changes the answer, and the crowd-aware layout holds inside the zone", async () => {
  const v = room(30, 10, [crowd("c1", sq(10, 0, 20, 10))], { c1: 4 });
  const cmp = await compareCrowd(v, { max_range_m: 14, resolution_m: 1, candidate_spacing_m: 2 }, { seed: 1, budget: 20000 });
  const J = cmp.judged_by_crowd_aware_criterion;
  assert.equal(cmp.status, "ok");
  assert.ok(cmp.difference.anchors_aware >= cmp.difference.anchors_unaware);
  assert.equal(J.aware.criterion_met, true); assert.equal(J.aware.regions.inside_crowd.uncovered_cells, 0);
  assert.equal(J.unaware.criterion_met, false);
  assert.ok(J.unaware.regions.inside_crowd.uncovered_fraction > 0);
  assert.equal(cmp.meets_plain_criterion.aware, true);            // stricter criterion implies the plain one
  assert.equal(cmp.meets_plain_criterion.unaware, true);
  // independent recount of the crowd-zone row from raw geometry
  const f = cmp._field, layout = cmp._layouts.unaware, P = cmp._problems.aware;
  let unc = 0, n = 0;
  for (let c = 0; c < P.N; c++) {
    const q = P.centre(c); if (!(f.at(q.x, q.y) > 0)) continue; n++;
    const usable = layout.map((j) => P.candidates[j]).filter((a) => distance(a, q) <= 14 * Math.max(0.5, 1 - 0.1 * f.pathMean(a, q)) && !lineOfSight(a, q, P.venue).blocked).length;
    if (usable < 3 + extraAnchors(M, f.at(q.x, q.y))) unc++;
  }
  assert.equal(n, J.unaware.regions.inside_crowd.cells); assert.equal(unc, J.unaware.regions.inside_crowd.uncovered_cells);
});

test("compare: different crowd circles give different answers; same inputs and seed repeat exactly", async () => {
  const run = (zones, dens) => compareCrowd(room(30, 10, zones, dens), { max_range_m: 14 }, { seed: 2 });
  const a = await run([crowd("c1", sq(0, 0, 8, 10))], { c1: 4 }), b = await run([crowd("c1", sq(12, 0, 20, 10))], { c1: 4 });
  assert.notDeepEqual(a.searches.aware.anchors, b.searches.aware.anchors);
  const a2 = await run([crowd("c1", sq(0, 0, 8, 10))], { c1: 4 });
  assert.deepEqual(a2.searches.aware.anchors, a.searches.aware.anchors);
  assert.equal(a2.config_hash, a.config_hash);
  const light = await run([crowd("c1", sq(0, 0, 8, 10))], { c1: 0.5 });
  assert.notEqual(light.config_hash, a.config_hash);
});

test("compare: refuses a plan with no crowd zone, zero density, or a zone without density", async () => {
  await assert.rejects(compareCrowd(room(20, 10), { max_range_m: 10 }), /no crowd zones/);
  await assert.rejects(compareCrowd(room(20, 10, [crowd("c1", sq(1, 1, 5, 5))], { c1: 0 }), { max_range_m: 10 }), /density 0/);
  await assert.rejects(compareCrowd(room(20, 10, [crowd("c1", sq(1, 1, 5, 5))]), { max_range_m: 10 }), /no density/);
  await assert.rejects(compareCrowd(room(20, 10, [crowd("c1", sq(1, 1, 5, 5))], { c1: 2 }), {}), /Maximum range/);
});

test("compare: an unreachable crowd requirement is reported as incomplete, not as success", async () => {
  const v = room(30, 10, [crowd("c1", sq(0, 0, 30, 10))], { c1: 4 });
  const cmp = await compareCrowd(v, { max_range_m: 10, crowd_model: { min_range_factor: 0.1, range_derate_per_density: 0.2 } }, { seed: 1 });
  assert.equal(cmp.status, "incomplete"); assert.equal(cmp.searches.aware.status, "not_met");
  assert.ok(cmp.warnings.some((w) => /did not meet/.test(w)));
});

test("report and CSV: contract formats, manifest hash, no invented simulated error", async () => {
  const plan = JSON.parse(readFileSync(join(fx, "sample_plan.json"), "utf8"));
  const venue = toVenue(planFromJson(plan), { created_at: plan.created_at });
  const cmp = await compareCrowd(venue, { max_range_m: 15, fallback_density: 2 }, { seed: 1, budget: 20000 });
  const rep = await buildCrowdComparisonReport({ cmp, planJson: plan, created_at: plan.created_at });
  assert.equal(rep.report_kind, "crowd_comparison"); assert.equal(rep.contract_version, "1.0");
  assert.match(rep.manifest.config_hash, /^[0-9a-f]{64}$/); assert.equal(rep.manifest.seed, 1);
  assert.equal(rep.simulated_error.status, "not_yet_generated");
  assert.ok(rep.warnings.some((w) => /site survey/i.test(w))); assert.ok(rep.warnings.some((w) => /fallback/.test(w)));
  assert.ok(!("_problems" in rep) && !("_layouts" in rep));
  JSON.stringify(rep);                                              // serialisable
  const csv = crowdComparisonCsv(cmp), lines = csv.trimEnd().split("\n");
  assert.ok(csv.endsWith("\n") && !csv.includes("\r") && !/NaN|undefined|null/.test(csv));
  assert.equal(lines.length, 1 + 3 * (3 + cmp.zones.length));
  assert.ok(lines.every((l) => l.split(",").length === 11));
  const acsv = crowdAnchorsCsv(cmp).trimEnd().split("\n");
  assert.equal(acsv.length - 1, cmp.difference.kept.length + cmp.difference.added_for_crowds.length + cmp.difference.removed_by_crowds.length);
  assert.ok(acsv.slice(1).every((l) => /^\d+,-?\d+\.\d{3},-?\d+\.\d{3},[01],[01],(kept|added_for_crowds|removed_by_crowds)$/.test(l)));
});

test("sample plan: saved example report is reproduced exactly from its inputs", async () => {
  const plan = JSON.parse(readFileSync(join(fx, "sample_plan.json"), "utf8"));
  const venue = toVenue(planFromJson(plan), { created_at: plan.created_at });
  const cmp = await compareCrowd(venue, { max_range_m: 15, fallback_density: 2 }, { seed: 1, budget: 20000 });
  const rep = await buildCrowdComparisonReport({ cmp, planJson: plan, created_at: plan.created_at });
  const saved = JSON.parse(readFileSync(join(fx, "sample_crowd.report.json"), "utf8"));
  delete saved.manifest.git_commit; delete rep.manifest.git_commit; delete saved.manifest.runtime; delete rep.manifest.runtime;
  assert.deepEqual(rep, saved);
  assert.equal(crowdComparisonCsv(cmp), readFileSync(join(fx, "sample_crowd.regions.csv"), "utf8"));
});
