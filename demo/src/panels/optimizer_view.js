// D8/D6 in the demo: the anchor placement optimizer's saved sample run (planner/fixtures/sample_optimizer.report.json,
// made by `make optimize` from sample_plan.json). The demo never ranks plans itself, and this panel does not
// stand in for the plan the user uploads in the planner. Pure: builds the view for the shared panel renderer.
const TITLE = "Anchor placement optimizer (saved sample run)";
const m = (v) => (v == null ? "n/a" : `${v.toFixed(2)} m`);
const yn = (b) => (b ? "yes" : "no");

export function buildOptimizerView(report) {
  const ok = report && Array.isArray(report.layouts) && Array.isArray(report.ranking) && Array.isArray(report.naive_comparison);
  if (!ok) return { id: "optimizer", title: TITLE, status: "not_yet_generated", statusText: "Not yet generated",
    caveats: [], summary: [], tables: [], notes: [] };
  const byId = Object.fromEntries(report.layouts.map((L) => [L.layout_id, L]));
  const best = report.best ? byId[report.best] : null;
  const notes = [{ level: "info", text: "Sample run from a saved plan. Upload your own plan in the planner to rank layouts for it." },
    { level: "info", text: `Judged by ${report.judged_by}. Errors are simulated, not measured. "Best" is best of these candidates, not a proven optimum.` }];
  for (const w of report.warnings ?? []) notes.push({ level: "info", text: w });
  return {
    id: "optimizer", title: TITLE, status: "ok", statusText: "Saved sample run, simulated",
    caveats: [], notes,
    summary: [
      ["Best of the candidates", best ? `${best.layout_id}, ${best.k} anchors, simulated P90 ${m(best.simulated.p90_m)}` : "none met the criterion"],
      ["Layouts", String(report.layouts.length)],
      ["Pareto-optimal", (report.pareto_front ?? []).join(", ") || "none"],
    ],
    tables: [
      {
        caption: "Ranked layouts",
        headers: ["Rank", "Layout", "Anchors", "Criterion met", "Median", "P90", "Inside crowd P90", "Pareto"],
        rows: report.ranking.map((id) => byId[id]).filter(Boolean).map((L) => [
          String(L.rank), L.layout_id, String(L.k), yn(L.coverage.criterion_met),
          m(L.simulated.median_m), m(L.simulated.p90_m), m(L.simulated.inside_crowd?.p90_m), yn(L.pareto_optimal)]),
      },
      {
        caption: "Optimised layout against a naive grid of the same size",
        headers: ["Anchors", "Optimised P90", "Naive grid P90", "Naive meets criterion"],
        rows: report.naive_comparison.map((n) => [String(n.k), m(n.optimised_p90_m), m(n.naive_p90_m), yn(n.naive_criterion_met)]),
      },
    ],
  };
}
