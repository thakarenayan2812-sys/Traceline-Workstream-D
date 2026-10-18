// Planner report (guide 15: "planner report JSON/CSV") with a manifest (guide 6/11).
import { sha256Hex, canonicalJson } from "./hash.js";
import { CONTRACT_VERSION, MIN_USABLE_ANCHORS } from "../core/constants.js";

export const SITE_SURVEY_WARNING =
  "Simulated geometric coverage only. It is not a guarantee of radio performance: walls, crowds, equipment and interference change real signals. Run a site survey before installing anything.";

/** assumptions are written in plain words so a customer can check them against their building. */
export function assumptionsFor(problem) {
  const o = problem.options;
  return [
    `A walkable grid cell counts as covered when at least ${o.required_usable_anchors ?? MIN_USABLE_ANCHORS} anchors are within ${o.max_range_m} m of its centre with no traced wall or obstacle in between.`,
    `Grid resolution is ${o.resolution_m} m; each cell is judged at its centre only, so small gaps inside a cell can be missed.`,
    "Range is an assumed hard limit set by the user, not a measured value. Real range varies with noise, obstructions and crowds.",
    "Every traced wall blocks completely. Walls that were not traced do not exist in this model.",
    `Anchors may only be placed at the ${problem.candidates.length} candidate positions tested (${o.mounting.mode === "wall_mounted" ? "along walls" : "on a regular floor lattice"}, spacing ${o.candidate_spacing_m} m, at least ${o.min_wall_clearance_m} m from any wall).`,
    "A 'proven' minimum holds only for that candidate set, grid and range; other positions could need fewer anchors.",
  ];
}

export async function buildCoverageReport({ result, problem, planJson, created_at = new Date().toISOString(), git_commit = null }) {
  const { _layout, ...res } = result;
  const config = {
    required_usable_anchors: problem.options.required_usable_anchors ?? MIN_USABLE_ANCHORS,
    max_range_m: problem.options.max_range_m, grid_resolution_m: problem.options.resolution_m,
    candidate_spacing_m: problem.options.candidate_spacing_m, min_wall_clearance_m: problem.options.min_wall_clearance_m,
    mounting: problem.options.mounting, seed: res.search.seed, search_budget: res.search.budget, max_anchors: res.search.max_anchors,
    plan_image_sha256: planJson?.source_image?.sha256 ?? null, plan_metres_per_px: planJson?.scale?.metres_per_px ?? null,
  };
  const warnings = [SITE_SURVEY_WARNING, ...(planJson?.validation?.warnings ?? [])];
  if (res.exceeds_model_slots) warnings.push(`This layout needs ${res.k} anchors; the model contract supports at most 8, so it cannot be exported into a venue file as is.`);
  if (res.status === "not_met") warnings.push(`The coverage criterion was not met (reason: ${res.reason}).`);
  return {
    schema_version: "1.0", contract_version: CONTRACT_VERSION, report_kind: "coverage_search",
    created_at, result: res, assumptions: assumptionsFor(problem), warnings,
    manifest: {
      seed: res.search.seed, config, config_hash: await sha256Hex(canonicalJson(config)),
      runtime: globalThis.process?.version ? `node ${globalThis.process.version}` : (globalThis.navigator?.userAgent ?? "unknown"),
      git_commit, created_at, script: "planner/src/plan/search.js",
    },
  };
}

/** anchors.csv: UTF-8, LF, dot decimal, positions to 3 decimals (guide 7). */
export function anchorsCsv(result) {
  return "anchor_id,x_m,y_m\n" + result.anchors.map((a) => `${a.anchor_id},${a.x_m.toFixed(3)},${a.y_m.toFixed(3)}`).join("\n") + "\n";
}
