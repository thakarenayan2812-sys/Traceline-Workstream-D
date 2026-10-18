// Anchor Placement Optimizer (guide 4 feature 1, guide 15 D6).
// For one blueprint it:
//   1. builds candidate layouts: D4 minimum-anchor searches (several seeds), a no-crowd search when crowd
//      zones exist, redundancy extensions of those layouts, and an evenly spaced naive grid per size;
//   2. judges every layout against the coverage criterion (crowd-aware when crowd zones carry density);
//   3. simulates readings on a fixed, seeded set of walks (stand-in simulator), runs a predictor on them and
//      scores median and P90 positioning error, overall and inside / outside crowd zones;
//   4. ranks the layouts that meet the criterion by an explicit objective, lists the Pareto front
//      (anchors versus P90 error) and compares each size with the naive grid of the same size.
// Honest limits: the simulator and the signal numbers are stand-ins; the default predictor is the mock
// trilateration, not Traceline; the candidate set is a finite list, so the ranking is "best of these",
// not a global optimum; the walks are a development set, not the hidden set.
import { MAX_ANCHOR_SLOTS, DT_S, MIN_USABLE_ANCHORS, CONTRACT_VERSION } from "../core/constants.js";
import { buildCoverageProblem, evaluateLayout, layoutCounts, naiveGridLayout, DEFAULTS } from "./coverage.js";
import { searchMinimumAnchors } from "./search.js";
import { crowdZonesFromVenue, stripCrowdZones, buildCrowdField, crowdOptions, resolveCrowdModel, describeCrowdModel } from "./crowd.js";
import { makeEvaluationSet, simulateReadings, crowdDensityAt, STAND_IN_SIGNAL, STAND_IN_CROWD_EFFECTS } from "../adapters/simulator_adapter.js";
import { buildModelInput, createMockPredictor, flagOutOfBounds } from "../adapters/inference_adapter.js";
import { validatePredictorOutput } from "../core/validate.js";
import { distance } from "../core/geometry.js";
import { sha256Hex, canonicalJson } from "./hash.js";
import { assumptionsFor } from "./coverage_report.js";

export const SLOT_POLICY_ID = "nearest_valid_by_range_v1";
export const SLOT_POLICY_TEXT = `Up to ${MAX_ANCHOR_SLOTS} anchor slots per step. With more anchors than slots, the ${MAX_ANCHOR_SLOTS} anchors with the smallest measured valid range are used (ties by anchor id), and unused slots are padded with anchors that have no reading. Measured ranges only; truth is never used.`;

const round = (v, d = 4) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Linear interpolation between closest ranks (the common "linear" percentile method). */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

/** Median, mean, RMSE, P90 and P95 of a list of errors in metres. Empty list gives nulls. */
export function errorStats(errs) {
  const n = errs.length;
  if (!n) return { steps: 0, median_m: null, mean_m: null, rmse_m: null, p90_m: null, p95_m: null };
  const s = [...errs].sort((a, b) => a - b);
  const mean = errs.reduce((a, b) => a + b, 0) / n;
  const rmse = Math.sqrt(errs.reduce((a, b) => a + b * b, 0) / n);
  return { steps: n, median_m: round(percentile(s, 0.5)), mean_m: round(mean), rmse_m: round(rmse), p90_m: round(percentile(s, 0.9)), p95_m: round(percentile(s, 0.95)) };
}

/**
 * Slots for one step. With at most MAX_ANCHOR_SLOTS anchors every anchor is used. Otherwise the slot policy
 * above applies. Only measured ranges are read here, so the choice cannot leak truth.
 */
export function chooseSlots(layout, rangeById, max = MAX_ANCHOR_SLOTS) {
  if (layout.length <= max) return layout;
  const valid = layout.filter((a) => isNum(rangeById.get(a.anchor_id)))
    .sort((a, b) => rangeById.get(a.anchor_id) - rangeById.get(b.anchor_id) || a.anchor_id - b.anchor_id);
  const chosen = valid.slice(0, max);
  if (chosen.length < max) {
    const rest = layout.filter((a) => !chosen.includes(a)).sort((a, b) => a.anchor_id - b.anchor_id);
    chosen.push(...rest.slice(0, max - chosen.length));
  }
  return chosen.sort((a, b) => a.anchor_id - b.anchor_id);
}

/**
 * Score one layout on a fixed evaluation set. The predictor sees ONLY buildModelInput's output, which is built
 * from measured ranges, RSSI and anchor coordinates. Truth is used after the prediction, to compute errors.
 * @param layout [{anchor_id, x_m, y_m, candidate_index}]
 * @param predictor {name, reset(), predict(input)}
 */
export async function scoreLayout(venue, layout, evalSet, { crowdZones = [], predictor, crowdEffects = STAND_IN_CROWD_EFFECTS, signal = STAND_IN_SIGNAL } = {}) {
  if (!predictor) throw new RangeError("scoreLayout needs a predictor.");
  const sims = simulateReadings(venue, evalSet, layout, { seed: evalSet.seed, crowdZones, crowdEffects, signal });
  const errAll = [], errIn = [], errOut = [];
  let oob = 0, tooFew = 0, readings = 0, valid = 0, nlosValid = 0, steps = 0;
  for (let ti = 0; ti < evalSet.trajectories.length; ti++) {
    const { truth } = evalSet.trajectories[ti];
    predictor.reset?.();
    let prev = null, state = null;
    for (let k = 0; k < truth.length; k++) {
      const rs = sims[ti].readings[k], ls = sims[ti].labels[k];
      const rangeById = new Map(rs.map((r) => [r.anchor_id, r.range_m]));
      const chosen = chooseSlots(layout, rangeById);
      const chosenIds = new Set(chosen.map((a) => a.anchor_id));
      const feed = rs.filter((r) => chosenIds.has(r.anchor_id)).map((r) => ({ anchor_id: r.anchor_id, range_m: r.range_m, rssi_dbm: r.rssi_dbm }));
      const stepVenue = { anchors: chosen.map((a) => ({ anchor_id: a.anchor_id, x_m: a.x_m, y_m: a.y_m, enabled: true })) };
      const input = buildModelInput(stepVenue, feed, prev, DT_S, state);
      const raw = await predictor.predict(input);
      const problems = validatePredictorOutput(raw);
      if (problems.length) throw new Error(`Predictor output rejected at trajectory ${ti}, step ${k}: ${problems.join(" ")}`);
      const out = flagOutOfBounds(raw, venue); // flagged, never clamped (guide 10.3)
      const est = { x: out.x_hat_m, y: out.y_hat_m };
      const err = distance(est, truth[k]);
      errAll.push(err);
      if (crowdZones.length) (crowdDensityAt(crowdZones, truth[k]) > 0 ? errIn : errOut).push(err);
      if (out.reason_codes.includes("OUT_OF_BOUNDS")) oob++;
      if (feed.filter((r) => r.range_m != null).length < 3) tooFew++;
      for (const r of rs) if (r.range_m != null) valid++;
      readings += rs.length;
      for (const l of ls) if (!l.lost && l.is_nlos) nlosValid++;
      prev = { x_hat_m: out.x_hat_m, y_hat_m: out.y_hat_m };
      state = out.state_out ?? null;
      steps++;
    }
  }
  const sim = {
    ...errorStats(errAll),
    out_of_bounds_fraction: round(oob / steps), too_few_valid_anchors_fraction: round(tooFew / steps),
    valid_reading_fraction: round(valid / readings), nlos_fraction_of_valid_readings: round(valid ? nlosValid / valid : null),
    inside_crowd: crowdZones.length ? errorStats(errIn) : null,
    outside_crowd: crowdZones.length ? errorStats(errOut) : null,
    predictor: predictor.name, predictor_is_mock: !!predictor.is_mock,
  };
  return sim;
}

/** Redundancy step: the candidate that gives the most cells a spare anchor (count <= required now). Heuristic. */
function addRedundancy(p, layout) {
  const count = layoutCounts(p, layout), inSet = new Set(layout);
  let best = -1, bestGain = -1;
  for (let j = 0; j < p.candidates.length; j++) {
    if (inSet.has(j)) continue;
    let g = 0;
    for (const c of p.vis[j]) if (count[c] <= p.required[c]) g++;
    if (g > bestGain) { bestGain = g; best = j; }
  }
  return best >= 0 ? [...layout, best] : null;
}

/**
 * Candidate layouts (guide 15: "generate candidate layouts"). Returns entries
 * {source, layout (sorted candidate indices), search_seed?, base_key?, extension_level?} plus the search log.
 * Duplicates are dropped within the optimised pool. Naive grids are kept separately as references.
 */
export async function buildCandidateLayouts({ judge, plain = null }, { seed = 1, budget, max_anchors, search_seeds = 3, extension_levels = 2, yieldFn = null } = {}) {
  const pool = [], seen = new Set(), searches = [], warnings = [];
  const add = (layout, meta) => {
    const sorted = [...layout].sort((a, b) => a - b), key = sorted.join(",");
    if (seen.has(key)) return null;
    seen.add(key);
    const entry = { ...meta, layout: sorted, key };
    pool.push(entry);
    return entry;
  };
  const runSearch = async (p, s, source) => {
    const res = await searchMinimumAnchors(p, { seed: s, budget, max_anchors, yieldFn });
    searches.push({ source, seed: s, status: res.status, reason: res.reason, k: res.k, label: res.label, lower_bound: res.lower_bound,
      proven: res.proven, evaluations_used: res.search.evaluations_used });
    if (res.status === "met") add(res._layout, { source, search_seed: s });
    else warnings.push(`${source} search with seed ${s} did not meet the criterion (reason: ${res.reason}); its layout is not in the ranking.`);
  };
  for (let s = 0; s < search_seeds; s++) await runSearch(judge, seed + s, "coverage_search");
  if (plain) await runSearch(plain, seed, "no_crowd_search");

  const bases = pool.map((e) => ({ ...e }));
  for (const base of bases) {
    let cur = base.layout;
    for (let level = 1; level <= extension_levels; level++) {
      const next = addRedundancy(judge, cur);
      if (!next) break;
      add(next, { source: "redundancy_extension", extension_level: level, base_key: base.key });
      cur = next;
    }
  }
  const sizes = [...new Set(pool.map((e) => e.layout.length))].sort((a, b) => a - b);
  const naive = sizes.map((k) => ({ source: "naive_grid", layout: [...naiveGridLayout(judge, k)].sort((a, b) => a - b), k_requested: k }));
  return { pool, naive, searches, warnings };
}

/** Pareto front on (anchors, P90): no other eligible layout is at least as good on both and better on one. */
function paretoIds(items) {
  const out = new Set();
  for (const a of items) {
    const dominated = items.some((b) => b !== a && b.k <= a.k && b.p90 <= a.p90 && (b.k < a.k || b.p90 < a.p90));
    if (!dominated) out.add(a.layout_id);
  }
  return out;
}

/**
 * Main entry point.
 * @param venue contract-9.1 venue from toVenue (walls, obstacles, boundary, zones, density metadata)
 * @param opts {max_range_m (required), resolution_m, candidate_spacing_m, mounting, fallback_density, crowd_aware (default true),
 *              crowd_model, seed, budget, max_anchors, search_seeds, extension_levels, anchor_cost_m, trajectories,
 *              steps, speed_mps, walk_radius_m}
 * @param runtime {predictor, yieldFn}
 */
export async function runAnchorOptimizer(venue, opts = {}, runtime = {}) {
  const seed = opts.seed ?? 1, res = opts.resolution_m ?? DEFAULTS.resolution_m;
  const anchorCost = opts.anchor_cost_m ?? 0;
  if (!isNum(anchorCost) || anchorCost < 0) throw new RangeError("Cost per anchor must be a number, 0 or more, in metres of error.");
  const evalCfg = { trajectories: opts.trajectories ?? 3, steps: opts.steps ?? 360, speed_mps: opts.speed_mps ?? 1.0, walk_radius_m: opts.walk_radius_m ?? 15 };
  if (!Number.isFinite(evalCfg.steps) || evalCfg.steps < 2) throw new RangeError("Run length must be at least 2 steps.");
  const predictor = runtime.predictor ?? createMockPredictor();
  const yieldFn = runtime.yieldFn ?? null;
  const warnings = [];

  const zones = crowdZonesFromVenue(venue, { fallback_density: opts.fallback_density ?? null });
  const base = { max_range_m: opts.max_range_m, resolution_m: res, candidate_spacing_m: opts.candidate_spacing_m ?? DEFAULTS.candidate_spacing_m, mounting: opts.mounting };
  Object.keys(base).forEach((k) => base[k] === undefined && delete base[k]);
  const crowdAware = opts.crowd_aware !== false && zones.some((z) => z.density_people_m2 > 0);
  let judge, plain = null, crowdModel = null;
  if (crowdAware) {
    crowdModel = resolveCrowdModel(opts.crowd_model);
    const field = buildCrowdField(venue, zones, res);
    judge = buildCoverageProblem(venue, { ...base, ...crowdOptions(field, crowdModel, MIN_USABLE_ANCHORS) });
    plain = buildCoverageProblem(stripCrowdZones(venue), base);
    if (JSON.stringify(plain.candidates) !== JSON.stringify(judge.candidates) || plain.N !== judge.N)
      throw new Error("Internal error: crowd and plain problems do not share candidates and cells, so layouts cannot be compared.");
  } else {
    judge = buildCoverageProblem(venue, base);
  }

  const evalSet = makeEvaluationSet(venue, { seed, ...evalCfg, resolution_m: res });
  const cand = await buildCandidateLayouts({ judge, plain }, { seed, budget: opts.budget ?? 20000, max_anchors: opts.max_anchors ?? 40,
    search_seeds: opts.search_seeds ?? 3, extension_levels: opts.extension_levels ?? 2, yieldFn });
  warnings.push(...cand.warnings);

  const anchorsOf = (layout) => layout.map((j, i) => ({ anchor_id: i, x_m: judge.candidates[j].x, y_m: judge.candidates[j].y, candidate_index: j }));
  const entries = [...cand.pool.map((e) => ({ ...e, pooled: true })), ...cand.naive.map((e) => ({ ...e, pooled: false }))];
  const ids = new Map();
  const layouts = [];
  for (const e of entries) {
    const layout_id = `L${String(layouts.length + 1).padStart(2, "0")}`;
    if (e.key) ids.set(e.key, layout_id);
    const anchors = anchorsOf(e.layout);
    const { counts, ...coverage } = evaluateLayout(judge, e.layout);
    // Crowd zones always shape the simulated world; `crowd_aware` only changes the coverage requirement.
    const sim = await scoreLayout(venue, anchors, evalSet, { crowdZones: zones, predictor });
    layouts.push({ layout_id, source: e.source, search_seed: e.search_seed ?? null, extension_level: e.extension_level ?? null,
      base_layout_id: e.base_key ?? null, k: e.layout.length, pooled: e.pooled, anchors,
      coverage: { criterion_met: coverage.criterion_met, uncovered_fraction: round(coverage.uncovered_fraction), uncovered_area_m2: round(coverage.uncovered_area_m2),
        worst_case: coverage.worst_case, walkable_cells: coverage.walkable_cells, walkable_area_m2: round(coverage.walkable_area_m2) },
      simulated: sim, exceeds_model_slots: e.layout.length > MAX_ANCHOR_SLOTS,
      objective_m: null, rank: null, pareto_optimal: false });
    if (yieldFn) await yieldFn();
  }
  for (const L of layouts) if (L.source !== "naive_grid") L.base_layout_id = L.base_layout_id ? ids.get(L.base_layout_id) ?? null : null;

  // Ranking: only layouts that meet the criterion and that came from the optimised pool.
  const eligible = layouts.filter((L) => L.pooled && L.coverage.criterion_met && L.simulated.median_m != null);
  for (const L of eligible) L.objective_m = round(L.simulated.p90_m + anchorCost * L.k);
  eligible.sort((a, b) => a.objective_m - b.objective_m || a.simulated.median_m - b.simulated.median_m || a.k - b.k || (a.layout_id < b.layout_id ? -1 : 1));
  eligible.forEach((L, i) => { L.rank = i + 1; });
  const frontier = paretoIds(eligible.map((L) => ({ layout_id: L.layout_id, k: L.k, p90: L.simulated.p90_m })));
  for (const L of eligible) L.pareto_optimal = frontier.has(L.layout_id);

  // Naive grid versus the best optimised layout with the same anchor count.
  const sizes = [...new Set([...eligible.map((L) => L.k), ...layouts.filter((L) => !L.pooled).map((L) => L.k)])].sort((a, b) => a - b);
  const naive_comparison = sizes.map((k) => {
    const opt = eligible.filter((L) => L.k === k).sort((a, b) => a.simulated.p90_m - b.simulated.p90_m)[0] ?? null;
    const nv = layouts.find((L) => !L.pooled && L.k === k) ?? null;
    return {
      k,
      optimised_layout_id: opt?.layout_id ?? null,
      optimised_p90_m: opt?.simulated.p90_m ?? null,
      optimised_median_m: opt?.simulated.median_m ?? null,
      naive_layout_id: nv?.layout_id ?? null,
      naive_criterion_met: nv?.coverage.criterion_met ?? null,
      naive_p90_m: nv?.simulated.p90_m ?? null,
      naive_median_m: nv?.simulated.median_m ?? null,
      naive_minus_optimised_p90_m: opt && nv?.simulated.p90_m != null ? round(nv.simulated.p90_m - opt.simulated.p90_m) : null,
    };
  });

  const best = eligible[0] ?? null;
  const bestInSlots = eligible.find((L) => !L.exceeds_model_slots) ?? null;
  const status = best ? "ok" : "no_layout_meets_criterion";
  if (!best) warnings.push("No candidate layout met the coverage criterion, so no ranking is given. Naive grids are shown for reference.");
  if (best && !bestInSlots) warnings.push(`No layout that meets the criterion fits the ${MAX_ANCHOR_SLOTS} model slots. The smallest one found needs ${Math.min(...eligible.map((L) => L.k))} anchors.`);
  if (best && best.k > MAX_ANCHOR_SLOTS) warnings.push(`The best layout (${best.layout_id}) needs ${best.k} anchors. The model takes at most ${MAX_ANCHOR_SLOTS} slots, so the simulation uses the slot policy above and the venue file cannot be exported with it (DECISIONS 39).`);
  if (layouts.some((L) => L.exceeds_model_slots)) warnings.push("Layouts above 8 anchors are simulated with the slot policy; that is an assumption until the team decides how a larger layout feeds an 8-slot model.");
  if (!evalSet.trajectories.length) warnings.push("No walks were simulated.");
  if (evalCfg.steps * DT_S < 120 || evalCfg.steps * DT_S > 300) warnings.push(`Run length ${evalCfg.steps * DT_S} s is outside the 120 to 300 s range in guide section 7.`);
  warnings.push("Positioning errors come from a stand-in simulator and the mock predictor. They are not Traceline results and not measurements.");
  if (zones.some((z) => z.density_source === "fallback")) warnings.push("Some crowd zones had no density and use the fallback density you entered.");
  if (best && best.simulated.inside_crowd && best.simulated.inside_crowd.steps < 200)
    warnings.push(`Only ${best.simulated.inside_crowd.steps} simulated steps fall inside crowd zones, so the inside-crowd error is indicative only. Use longer walks or more trajectories.`);

  const config = {
    max_range_m: judge.options.max_range_m, grid_resolution_m: res, candidate_spacing_m: judge.options.candidate_spacing_m, mounting: judge.options.mounting,
    min_wall_clearance_m: judge.options.min_wall_clearance_m, crowd_aware: crowdAware, crowd_model: crowdModel,
    fallback_density: opts.fallback_density ?? null, zones: zones.map((z) => ({ zone_id: z.zone_id, density_people_m2: z.density_people_m2, density_source: z.density_source })),
    seed, search_budget: opts.budget ?? 20000, max_anchors: opts.max_anchors ?? 40, search_seeds: opts.search_seeds ?? 3, extension_levels: opts.extension_levels ?? 2,
    anchor_cost_m: anchorCost, evaluation: { ...evalCfg, dt_s: DT_S, seed }, signal: STAND_IN_SIGNAL, crowd_effects: STAND_IN_CROWD_EFFECTS,
    slot_policy: SLOT_POLICY_ID, predictor: predictor.name,
  };
  return {
    status, label: best ? "Ranking of candidate layouts under the stand-in simulator (not a global optimum)" : null,
    objective: { definition: "objective_m = P90 positioning error (m) + anchor_cost_m x anchors. Ranked low to high; ties by median, then fewer anchors.", anchor_cost_m: anchorCost,
      note: anchorCost === 0 ? "Default cost 0: layouts are ranked by P90 error alone, so the Pareto front shows what extra anchors buy." : "Cost per anchor is set by the user." },
    config, config_hash: await sha256Hex(canonicalJson(config)),
    crowd_model_description: crowdAware ? describeCrowdModel(crowdModel) : [],
    assumptions: assumptionsFor(judge),
    evaluation_set: { seed, trajectories: evalSet.trajectories.length, steps_per_trajectory: evalCfg.steps, dt_s: DT_S, speed_mps: evalCfg.speed_mps,
      walk_radius_m: evalCfg.walk_radius_m, total_steps: evalCfg.steps * evalSet.trajectories.length,
      note: "Walks are seeded random walks through the walkable area. Development set only: never the hidden set." },
    simulator: { name: "stand-in (planner/src/adapters/simulator_adapter.js)", is_stand_in: true, signal: STAND_IN_SIGNAL, crowd_effects: STAND_IN_CROWD_EFFECTS, crowd_zones_used: crowdAware ? zones.length : 0 },
    predictor: { name: predictor.name, is_mock: !!predictor.is_mock },
    slot_policy: { id: SLOT_POLICY_ID, text: SLOT_POLICY_TEXT },
    judged_by: crowdAware ? "crowd_aware" : "plain",
    searches: cand.searches,
    layouts,
    ranking: eligible.map((L) => L.layout_id),
    pareto_front: eligible.filter((L) => L.pareto_optimal).map((L) => L.layout_id),
    best: best?.layout_id ?? null,
    best_within_model_slots: bestInSlots?.layout_id ?? null,
    naive_comparison,
    warnings,
    notes: [
      "Layouts are compared on the same walks, with the same noise on shared anchors (common random numbers), so a difference comes from geometry and layout.",
      "Crowd effects are placeholders in the stand-in simulator. They change simulated error inside crowd zones, so that comparison depends on them.",
      "Naive grid: evenly spaced, snapped to the same candidate positions. Not counted in any search budget.",
    ],
    contract_version: CONTRACT_VERSION,
  };
}
