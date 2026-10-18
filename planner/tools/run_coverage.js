// Re-runnable coverage search from a plan.json. Same inputs and seed always give the same report.
// Usage: node tools/run_coverage.js <plan.json> --range 15 [--resolution 1] [--spacing 2] [--seed 1]
//        [--budget 20000] [--max-anchors 40] [--mounting floor_area|wall_mounted] [--out reports/name]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { planFromJson, toVenue } from "../src/plan/plan_export.js";
import { buildCoverageProblem } from "../src/plan/coverage.js";
import { searchMinimumAnchors } from "../src/plan/search.js";
import { buildCoverageReport, anchorsCsv } from "../src/plan/coverage_report.js";

const args = process.argv.slice(2);
const file = args[0];
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
if (!file || opt("range") === undefined) { console.error("Usage: node tools/run_coverage.js <plan.json> --range <metres> [options]"); process.exit(1); }

const planJson = JSON.parse(readFileSync(file, "utf8"));
const venue = toVenue(planFromJson(planJson), { created_at: planJson.created_at });
const problem = buildCoverageProblem(venue, {
  max_range_m: Number(opt("range")), resolution_m: Number(opt("resolution", 1)), candidate_spacing_m: Number(opt("spacing", 2)),
  mounting: { mode: opt("mounting", "floor_area") },
});
const result = await searchMinimumAnchors(problem, { seed: Number(opt("seed", 1)), budget: Number(opt("budget", 20000)), max_anchors: Number(opt("max-anchors", 40)) });
let commit = null; try { commit = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const report = await buildCoverageReport({ result, problem, planJson, created_at: planJson.created_at, git_commit: commit });

const out = opt("out", join("reports", basename(file, ".json") + "_coverage"));
mkdirSync(dirname(out) === "." ? "." : dirname(out), { recursive: true });
writeFileSync(out + ".report.json", JSON.stringify(report, null, 2) + "\n");
writeFileSync(out + ".anchors.csv", anchorsCsv(result));
const c = result.coverage;
console.log(`${result.label}\n  anchors: ${result.k} (lower bound ${result.lower_bound}, greedy ${result.greedy_pruned_size})`
  + `\n  uncovered: ${(c.uncovered_fraction * 100).toFixed(2)}% (${c.uncovered_area_m2} m2), worst point (${c.worst_case.x_m.toFixed(2)}, ${c.worst_case.y_m.toFixed(2)}) with ${c.worst_case.usable_anchors} usable anchors`
  + `\n  evaluations: ${result.search.evaluations_used} of ${result.search.budget}; naive grid needs ${result.naive_grid.min_k_to_meet ?? "more than " + Math.max(result.search.max_anchors, result.k)}`
  + `\n  wrote ${out}.report.json and ${out}.anchors.csv`);
