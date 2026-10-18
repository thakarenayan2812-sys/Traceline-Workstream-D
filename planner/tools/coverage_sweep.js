// Re-runnable sensitivity sweep on a plan.json: result vs assumed range and vs search budget.
// Usage: node tools/coverage_sweep.js [plan.json]   (default fixtures/sample_plan.json)
// Timings depend on the machine; counts depend only on inputs and seed.
import { readFileSync } from "node:fs";
import { planFromJson, toVenue } from "../src/plan/plan_export.js";
import { buildCoverageProblem } from "../src/plan/coverage.js";
import { searchMinimumAnchors } from "../src/plan/search.js";

const file = process.argv[2] ?? new URL("../fixtures/sample_plan.json", import.meta.url);
const plan = JSON.parse(readFileSync(file, "utf8"));
const venue = toVenue(planFromJson(plan), { created_at: plan.created_at });
console.log(`plan ${plan.transform.width_m} x ${plan.transform.height_m} m, seed 1, resolution 1 m, spacing 2 m`);

console.log("\nRange sweep (budget 20000):");
for (const range of [10, 15, 20, 25]) {
  const t = performance.now(), p = buildCoverageProblem(venue, { max_range_m: range });
  const r = await searchMinimumAnchors(p, { seed: 1, budget: 20000 });
  console.log(`  range ${range} m: ${r.status} k=${r.k} lower bound ${r.lower_bound} greedy ${r.greedy_pruned_size} naive-grid needs ${r.naive_grid.min_k_to_meet ?? ">" + r.search.max_anchors} (${(performance.now() - t).toFixed(0)} ms)`);
}
console.log("\nBudget sweep (range 15 m):");
const p = buildCoverageProblem(venue, { max_range_m: 15 });
for (const budget of [5000, 20000, 100000, 400000]) {
  const r = await searchMinimumAnchors(p, { seed: 1, budget });
  console.log(`  budget ${budget}: ${r.status}${r.reason ? " (" + r.reason + ")" : ""} k=${r.k} evaluations ${r.search.evaluations_used}`);
}
console.log(`\nnode ${process.version}`);
