// Anchor Placement Optimizer from a plan.json (D6). Stand-in simulator, mock predictor unless one is supplied.
// Usage: node tools/run_optimizer.js <plan.json> --range 15 [--fallback-density 2] [--resolution 1] [--spacing 2]
//        [--seed 1] [--budget 20000] [--max-anchors 40] [--search-seeds 3] [--extensions 2]
//        [--trajectories 3] [--steps 360] [--speed 1.0] [--walk-radius 15] [--anchor-cost 0]
//        [--mounting floor_area|wall_mounted] [--out reports/name]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { planFromJson, toVenue } from "../src/plan/plan_export.js";
import { runAnchorOptimizer } from "../src/plan/optimizer.js";
import { buildOptimizerReport, rankingCsv, layoutAnchorsCsv } from "../src/plan/optimizer_report.js";

const args = process.argv.slice(2), file = args[0];
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
if (!file || opt("range") === undefined) {
  console.error("Usage: node tools/run_optimizer.js <plan.json> --range <metres> [--fallback-density <people/m2>] [options]");
  process.exit(1);
}
const num = (n) => (opt(n) === undefined ? undefined : Number(opt(n)));
const planJson = JSON.parse(readFileSync(file, "utf8"));
const venue = toVenue(planFromJson(planJson), { created_at: planJson.created_at });
let result;
try {
  result = await runAnchorOptimizer(venue, {
    max_range_m: Number(opt("range")), resolution_m: num("resolution") ?? 1, candidate_spacing_m: num("spacing") ?? 2,
    mounting: { mode: opt("mounting", "floor_area") }, fallback_density: num("fallback-density") ?? null,
    seed: num("seed") ?? 1, budget: num("budget") ?? 20000, max_anchors: num("max-anchors") ?? 40,
    search_seeds: num("search-seeds") ?? 3, extension_levels: num("extensions") ?? 2,
    trajectories: num("trajectories") ?? 3, steps: num("steps") ?? 360, speed_mps: num("speed") ?? 1.0,
    walk_radius_m: num("walk-radius") ?? 15, anchor_cost_m: num("anchor-cost") ?? 0,
  });
} catch (e) { console.error("Cannot optimise: " + e.message); process.exit(1); }
let commit = null; try { commit = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const report = await buildOptimizerReport({ result, planJson, created_at: planJson.created_at, git_commit: commit });
const out = opt("out", join("reports", basename(file, ".json") + "_optimizer"));
mkdirSync(dirname(out) === "." ? "." : dirname(out), { recursive: true });
writeFileSync(out + ".report.json", JSON.stringify(report, null, 2) + "\n");
writeFileSync(out + ".ranking.csv", rankingCsv(result));
if (result.best) writeFileSync(out + ".best_anchors.csv", layoutAnchorsCsv(result, result.best));

const pct = (v) => (v == null ? "n/a" : v.toFixed(2) + " m");
console.log(`status: ${result.status}; judged ${result.judged_by}; ${result.layouts.length} layouts, ${result.ranking.length} ranked`);
console.log(`best: ${result.best ?? "none"}${result.best ? ` (${result.layouts.find((L) => L.layout_id === result.best).k} anchors, P90 ${pct(result.layouts.find((L) => L.layout_id === result.best).simulated.p90_m)})` : ""}`);
console.log(`pareto front: ${result.pareto_front.join(", ") || "none"}`);
for (const row of result.naive_comparison) {
  console.log(`  k=${String(row.k).padEnd(3)} optimised P90 ${pct(row.optimised_p90_m).padEnd(9)} naive grid P90 ${pct(row.naive_p90_m).padEnd(9)} ${row.naive_criterion_met === false ? "(naive does not meet criterion)" : ""}`);
}
for (const w of result.warnings) console.log("warning: " + w);
console.log(`wrote ${out}.report.json, ${out}.ranking.csv${result.best ? `, ${out}.best_anchors.csv` : ""}`);
