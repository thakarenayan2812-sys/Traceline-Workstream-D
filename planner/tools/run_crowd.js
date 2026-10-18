// Crowd-aware comparison from a plan.json: same blueprint with and without its crowd zones.
// Usage: node tools/run_crowd.js <plan.json> --range 15 [--fallback-density 2] [--resolution 1] [--spacing 2] [--seed 1]
//        [--budget 20000] [--max-anchors 40] [--mounting floor_area|wall_mounted] [--out reports/name]
//        [--derate 0.1] [--min-factor 0.5] [--density-per-extra 2] [--max-extra 2]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { planFromJson, toVenue } from "../src/plan/plan_export.js";
import { compareCrowd, buildCrowdComparisonReport, crowdComparisonCsv, crowdAnchorsCsv } from "../src/plan/crowd_compare.js";

const args = process.argv.slice(2), file = args[0];
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };
if (!file || opt("range") === undefined) { console.error("Usage: node tools/run_crowd.js <plan.json> --range <metres> [--fallback-density <people/m2>] [options]"); process.exit(1); }
const num = (n) => (opt(n) === undefined ? undefined : Number(opt(n)));
const planJson = JSON.parse(readFileSync(file, "utf8"));
const venue = toVenue(planFromJson(planJson), { created_at: planJson.created_at });
const model = Object.fromEntries(Object.entries({ range_derate_per_density: num("derate"), min_range_factor: num("min-factor"),
  density_per_extra_anchor: num("density-per-extra"), max_extra_anchors: num("max-extra") }).filter(([, v]) => v !== undefined));
let cmp;
try {
  cmp = await compareCrowd(venue, { max_range_m: Number(opt("range")), resolution_m: Number(opt("resolution", 1)), candidate_spacing_m: Number(opt("spacing", 2)),
    mounting: { mode: opt("mounting", "floor_area") }, crowd_model: model, fallback_density: opt("fallback-density") === undefined ? null : Number(opt("fallback-density")) },
  { seed: Number(opt("seed", 1)), budget: Number(opt("budget", 20000)), max_anchors: Number(opt("max-anchors", 40)) });
} catch (e) { console.error("Cannot compare: " + e.message); process.exit(1); }
let commit = null; try { commit = execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const report = await buildCrowdComparisonReport({ cmp, planJson, created_at: planJson.created_at, git_commit: commit });
const out = opt("out", join("reports", basename(file, ".json") + "_crowd"));
mkdirSync(dirname(out) === "." ? "." : dirname(out), { recursive: true });
writeFileSync(out + ".report.json", JSON.stringify(report, null, 2) + "\n");
writeFileSync(out + ".regions.csv", crowdComparisonCsv(cmp));
writeFileSync(out + ".anchors.csv", crowdAnchorsCsv(cmp));
const J = cmp.judged_by_crowd_aware_criterion, d = cmp.difference, pc = (v) => v == null ? "n/a" : (v * 100).toFixed(2) + "%";
console.log(`crowd zones: ${cmp.zones.map((z) => `${z.zone_id} ${z.density_people_m2}/m2 (${z.density_source})`).join(", ")}`);
console.log(`anchors: without crowd zones ${d.anchors_unaware}, crowd-aware ${d.anchors_aware} (${d.extra_anchors_for_crowds >= 0 ? "+" : ""}${d.extra_anchors_for_crowds}); kept ${d.kept.length}, added ${d.added_for_crowds.length}, removed ${d.removed_by_crowds.length}`);
for (const [name, j] of Object.entries(J)) console.log(`  ${name.padEnd(18)} k=${String(j.anchors).padEnd(3)} inside crowd: uncovered ${pc(j.regions.inside_crowd.uncovered_fraction)}, mean usable ${j.regions.inside_crowd.mean_usable_anchors} | outside: uncovered ${pc(j.regions.outside_crowd.uncovered_fraction)}`);
console.log(`extra anchors ${d.extra_anchors_for_crowds}; search variation between two seeds ${d.search_variation_anchors}; ${d.extra_exceeds_search_variation ? "the extra is larger than that variation" : "the extra is NOT larger than that variation, so it cannot be told apart from search noise"}`);
console.log(`seed control: unaware search with seed ${d.seed_control.seed} -> ${d.seed_control.anchors} anchors, ${d.seed_control.shared_with_unaware} shared with the first unaware layout`);
console.log(`wrote ${out}.report.json, ${out}.regions.csv, ${out}.anchors.csv`);
