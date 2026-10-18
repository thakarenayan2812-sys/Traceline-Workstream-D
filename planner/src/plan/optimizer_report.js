// Report JSON, ranking CSV and anchor CSV for the Anchor Placement Optimizer (D6), with a manifest (guide 6 and 11).
import { sha256Hex, canonicalJson } from "./hash.js";
import { SITE_SURVEY_WARNING } from "./coverage_report.js";

/** Report JSON. `result` is the object from runAnchorOptimizer; `_`-prefixed fields are not written. */
export async function buildOptimizerReport({ result, planJson = null, created_at = new Date().toISOString(), git_commit = null }) {
  const { config_hash, ...body } = result;
  const full = { ...result.config, plan_image_sha256: planJson?.source_image?.sha256 ?? null, plan_metres_per_px: planJson?.scale?.metres_per_px ?? null };
  return {
    schema_version: "1.0",
    report_kind: "anchor_placement_optimizer",
    created_at,
    ...body,
    assumptions: [
      ...result.assumptions,
      "Positioning error is simulated with a stand-in simulator and the mock predictor. It is not a measurement and not a Traceline result.",
      "Anchor positions are chosen from a finite candidate set, so the ranking is the best of the layouts tested.",
    ],
    warnings: [SITE_SURVEY_WARNING, ...result.warnings, ...(planJson?.validation?.warnings ?? [])],
    manifest: {
      seed: result.config.seed, config: full, config_hash: await sha256Hex(canonicalJson(full)),
      runtime: globalThis.process?.version ? `node ${globalThis.process.version}` : (globalThis.navigator?.userAgent ?? "unknown"),
      git_commit, created_at, script: "planner/tools/run_optimizer.js",
    },
  };
}

const f = (v) => (v == null ? "" : String(v));

/** One row per layout, ranked ones first. UTF-8, LF, dot decimals, blanks for missing values. */
export function rankingCsv(result) {
  const head = "rank,layout_id,source,anchors,criterion_met,uncovered_fraction,objective_m,p90_m,median_m,rmse_m,p95_m,inside_crowd_p90_m,inside_crowd_median_m,pareto_optimal,exceeds_model_slots,out_of_bounds_fraction,nlos_fraction_of_valid_readings";
  const order = [...result.layouts].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.layout_id.localeCompare(b.layout_id));
  const rows = order.map((L) => [L.rank, L.layout_id, L.source, L.k, L.coverage.criterion_met, L.coverage.uncovered_fraction, L.objective_m,
    L.simulated.p90_m, L.simulated.median_m, L.simulated.rmse_m, L.simulated.p95_m,
    L.simulated.inside_crowd?.p90_m ?? null, L.simulated.inside_crowd?.median_m ?? null,
    L.pareto_optimal, L.exceeds_model_slots, L.simulated.out_of_bounds_fraction, L.simulated.nlos_fraction_of_valid_readings]
    .map(f).join(","));
  return head + "\n" + rows.join("\n") + "\n";
}

/** Anchor positions of one layout to 3 decimals (contract 9.1 coordinate frame, metres). */
export function layoutAnchorsCsv(result, layoutId) {
  const L = result.layouts.find((x) => x.layout_id === layoutId);
  if (!L) throw new RangeError(`No layout ${layoutId} in this result.`);
  return "anchor_id,x_m,y_m,candidate_index\n" + L.anchors.map((a) => `${a.anchor_id},${a.x_m.toFixed(3)},${a.y_m.toFixed(3)},${a.candidate_index}`).join("\n") + "\n";
}
