// Same blueprint, with and without its crowd zones (guide 15). Three layouts are judged against the SAME
// crowd-aware requirement, region by region:
//   unaware      : minimum-anchor search with the crowd zones removed (what D4 would give)
//   aware        : minimum-anchor search under the crowd model
//   naive grid   : an evenly spaced grid with as many anchors as `aware`, a fixed reference
// plus a seed control (the unaware search repeated with another seed) so that a difference between two
// layouts can be told apart from ordinary search variation.
// Honest limit: the crowd model is an assumption, so "aware beats unaware inside crowd zones" is largely
// true by construction. What this measures is HOW MANY anchors the assumption costs and where they go.
// Simulated positioning error (median / P90) needs A's simulator and arrives with D6.
import { buildCoverageProblem, evaluateLayout, layoutCounts, naiveGridLayout, DEFAULTS } from "./coverage.js";
import { searchMinimumAnchors } from "./search.js";
import { crowdZonesFromVenue, stripCrowdZones, buildCrowdField, crowdOptions, resolveCrowdModel, describeCrowdModel } from "./crowd.js";
import { pointInPolygon } from "../core/geometry.js";
import { sha256Hex, canonicalJson } from "./hash.js";
import { CONTRACT_VERSION, MIN_USABLE_ANCHORS } from "../core/constants.js";
import { SITE_SURVEY_WARNING, assumptionsFor } from "./coverage_report.js";

const r4 = (v) => (v == null ? null : Math.round(v * 10000) / 10000);

function regionStats(problem, counts, mask) {
  let cells = 0, unc = 0, sum = 0, req = 0, min = Infinity;
  for (let c = 0; c < problem.N; c++) {
    if (!mask[c]) continue;
    cells++; sum += counts[c]; req += problem.required[c]; min = Math.min(min, counts[c]);
    if (counts[c] < problem.required[c]) unc++;
  }
  const area = problem.grid.resolution_m ** 2;
  return {
    cells, area_m2: r4(cells * area), uncovered_cells: unc, uncovered_fraction: cells ? r4(unc / cells) : null,
    mean_usable_anchors: cells ? r4(sum / cells) : null, min_usable_anchors: cells ? min : null, mean_required_anchors: cells ? r4(req / cells) : null,
  };
}

/** Region masks over the compact cell list: all, inside_crowd, outside_crowd and one per crowd zone. */
function regions(problem, field, zones) {
  const N = problem.N, all = new Uint8Array(N).fill(1), inside = new Uint8Array(N), outside = new Uint8Array(N);
  const perZone = zones.map(() => new Uint8Array(N));
  for (let c = 0; c < N; c++) {
    const q = problem.centre(c);
    if (field.at(q.x, q.y) > 0) inside[c] = 1; else outside[c] = 1;
    zones.forEach((z, k) => { if (pointInPolygon(q, z.polygon) !== "outside") perZone[k][c] = 1; });
  }
  return [{ id: "all", kind: "all", mask: all }, { id: "inside_crowd", kind: "inside_crowd", mask: inside }, { id: "outside_crowd", kind: "outside_crowd", mask: outside },
    ...zones.map((z, k) => ({ id: z.zone_id, kind: "zone", density_people_m2: z.density_people_m2, mask: perZone[k] }))];
}

/**
 * @param venue contract-9.1 venue from toVenue (zones + metadata.zone_density_people_m2)
 * @param opts {max_range_m, resolution_m, candidate_spacing_m, mounting, crowd_model, fallback_density}
 * @param search {seed, budget, max_anchors, yieldEvery, yieldFn, shouldStop}
 */
export async function compareCrowd(venue, opts, search = {}) {
  const model = resolveCrowdModel(opts.crowd_model);
  const zones = crowdZonesFromVenue(venue, { fallback_density: opts.fallback_density ?? null });
  if (!zones.length) throw new RangeError("This plan has no crowd zones. Draw a crowd circle or a crowd zone first.");
  const res = opts.resolution_m ?? DEFAULTS.resolution_m;
  const field = buildCrowdField(venue, zones, res);
  if (!field.anyCrowd) throw new RangeError("Every crowd zone has density 0, so there is nothing to compare. Enter a density above 0.");
  const base = { max_range_m: opts.max_range_m, resolution_m: res, candidate_spacing_m: opts.candidate_spacing_m, mounting: opts.mounting };
  Object.keys(base).forEach((k) => base[k] === undefined && delete base[k]);

  const plainProblem = buildCoverageProblem(stripCrowdZones(venue), base);
  const awareProblem = buildCoverageProblem(venue, { ...base, ...crowdOptions(field, model, MIN_USABLE_ANCHORS) });
  if (JSON.stringify(plainProblem.candidates) !== JSON.stringify(awareProblem.candidates) || plainProblem.N !== awareProblem.N)
    throw new Error("Internal error: the two problems do not share candidates and cells, so layouts cannot be compared.");

  const seed = search.seed ?? 1;
  const unaware = await searchMinimumAnchors(plainProblem, search);
  const aware = await searchMinimumAnchors(awareProblem, search);
  const control = await searchMinimumAnchors(plainProblem, { ...search, seed: seed + 1 });

  const layouts = { unaware: unaware._layout, aware: aware._layout, naive_grid_same_k: aware.k ? naiveGridLayout(awareProblem, aware.k) : [] };
  const regs = regions(awareProblem, field, zones);
  const judged = {};
  for (const [name, layout] of Object.entries(layouts)) {
    const counts = layoutCounts(awareProblem, layout);
    judged[name] = { anchors: layout.length, criterion_met: evaluateLayout(awareProblem, layout).criterion_met,
      regions: Object.fromEntries(regs.map((r) => [r.id, regionStats(awareProblem, counts, r.mask)])) };
  }
  const plainJudgement = {
    unaware: evaluateLayout(plainProblem, layouts.unaware).criterion_met,
    aware: evaluateLayout(plainProblem, layouts.aware).criterion_met,
  };

  const U = new Set(layouts.unaware), A = new Set(layouts.aware), C = new Set(control._layout);
  const pos = (j) => ({ candidate_index: j, x_m: awareProblem.candidates[j].x, y_m: awareProblem.candidates[j].y });
  const difference = {
    anchors_unaware: unaware.k, anchors_aware: aware.k, extra_anchors_for_crowds: aware.k - unaware.k,
    kept: [...A].filter((j) => U.has(j)).map(pos), added_for_crowds: [...A].filter((j) => !U.has(j)).map(pos), removed_by_crowds: [...U].filter((j) => !A.has(j)).map(pos),
    search_variation_anchors: Math.abs(control.k - unaware.k),
    extra_exceeds_search_variation: aware.k - unaware.k > Math.abs(control.k - unaware.k),
    seed_control: { seed: seed + 1, anchors: control.k, shared_with_unaware: [...C].filter((j) => U.has(j)).length,
      note: "The unaware search repeated with another seed. If this shared count is close to the aware/unaware shared count, the layout differences could be search variation rather than the crowd model." },
  };

  const config = {
    max_range_m: awareProblem.options.max_range_m, grid_resolution_m: res, candidate_spacing_m: awareProblem.options.candidate_spacing_m, mounting: awareProblem.options.mounting,
    crowd_model: model, fallback_density: opts.fallback_density ?? null, seed, search_budget: unaware.search.budget, max_anchors: unaware.search.max_anchors,
    zones: zones.map((z) => ({ zone_id: z.zone_id, density_people_m2: z.density_people_m2, density_source: z.density_source })),
  };
  const warnings = [SITE_SURVEY_WARNING];
  if (unaware.status !== "met") warnings.push(`The search without crowd zones did not meet the criterion (reason: ${unaware.reason}); the comparison is not meaningful.`);
  if (aware.status !== "met") warnings.push(`The crowd-aware search did not meet the criterion (reason: ${aware.reason}). ${aware.infeasible.cells ? `${aware.infeasible.cells} cells cannot reach enough anchors under the crowd model. ` : ""}Its layout is shown for reference only.`);
  if (zones.some((z) => z.density_source === "fallback")) warnings.push("Some crowd zones had no density and use the fallback density you entered.");
  if (aware.k > 8 || unaware.k > 8) warnings.push("A layout needs more than 8 anchors, so it cannot be exported into a venue file (model contract: at most 8 slots).");
  return {
    status: unaware.status === "met" && aware.status === "met" ? "ok" : "incomplete", config, config_hash: await sha256Hex(canonicalJson(config)),
    crowd_model: model, crowd_model_description: describeCrowdModel(model), zones,
    searches: { unaware: strip(unaware), aware: strip(aware), unaware_seed_control: strip(control) },
    judged_by_crowd_aware_criterion: judged, meets_plain_criterion: plainJudgement, difference, warnings,
    simulated_error: { status: "not_yet_generated", reason: "Median and P90 positioning error under crowds need the simulator adapter built in D6." },
    notes: [
      "All three layouts use the same candidate positions, grid and range; only the crowd model differs.",
      "The aware requirement is stricter by construction, so it needs at least as many anchors. The result shows how many more and where, not that real accuracy improves.",
      "Simulated positioning error inside crowd zones is the real test and is not part of this report.",
    ],
    _problems: { plain: plainProblem, aware: awareProblem }, _layouts: layouts, _field: field,
  };
}

const strip = ({ _layout, ...rest }) => rest;

/** Report JSON with manifest (guide 6 and 11). */
export async function buildCrowdComparisonReport({ cmp, planJson = null, created_at = new Date().toISOString(), git_commit = null }) {
  const { _problems, _layouts, _field, config, config_hash, ...body } = cmp;
  const full = { ...config, plan_image_sha256: planJson?.source_image?.sha256 ?? null, plan_metres_per_px: planJson?.scale?.metres_per_px ?? null };
  return {
    schema_version: "1.0", contract_version: CONTRACT_VERSION, report_kind: "crowd_comparison", created_at,
    ...body, assumptions: assumptionsFor(_problems.aware).concat(cmp.crowd_model_description),
    warnings: [...cmp.warnings, ...(planJson?.validation?.warnings ?? [])],
    manifest: { seed: config.seed, config: full, config_hash: await sha256Hex(canonicalJson(full)),
      runtime: globalThis.process?.version ? `node ${globalThis.process.version}` : (globalThis.navigator?.userAgent ?? "unknown"),
      git_commit, created_at, script: "planner/src/plan/crowd_compare.js" },
  };
}

const f = (v) => (v == null ? "" : String(v));
/** One row per region and layout, judged by the crowd-aware criterion. UTF-8, LF, dot decimals, blanks for missing. */
export function crowdComparisonCsv(cmp) {
  const head = "region,region_kind,layout,anchors,cells,area_m2,uncovered_cells,uncovered_fraction,mean_usable_anchors,min_usable_anchors,mean_required_anchors";
  const kinds = { all: "all", inside_crowd: "inside_crowd", outside_crowd: "outside_crowd" };
  const rows = [];
  for (const [layout, j] of Object.entries(cmp.judged_by_crowd_aware_criterion))
    for (const [id, s] of Object.entries(j.regions))
      rows.push([id, kinds[id] ?? "zone", layout, j.anchors, s.cells, s.area_m2, s.uncovered_cells, s.uncovered_fraction, s.mean_usable_anchors, s.min_usable_anchors, s.mean_required_anchors].map(f).join(","));
  return head + "\n" + rows.join("\n") + "\n";
}

/** Which anchors the crowd model keeps, adds and removes. Positions to 3 decimals. */
export function crowdAnchorsCsv(cmp) {
  const d = cmp.difference, all = [...d.kept.map((a) => [a, "kept", 1, 1]), ...d.added_for_crowds.map((a) => [a, "added_for_crowds", 0, 1]), ...d.removed_by_crowds.map((a) => [a, "removed_by_crowds", 1, 0])]
    .sort((p, q) => p[0].x_m - q[0].x_m || p[0].y_m - q[0].y_m);
  return "candidate_index,x_m,y_m,in_unaware_layout,in_aware_layout,change\n"
    + all.map(([a, ch, u, w]) => `${a.candidate_index},${a.x_m.toFixed(3)},${a.y_m.toFixed(3)},${u},${w},${ch}`).join("\n") + "\n";
}
