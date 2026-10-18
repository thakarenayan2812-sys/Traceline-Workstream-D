// D8 demo: the saved optimizer sample run as a panel. Pure, no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildOptimizerView } from "../src/panels/optimizer_view.js";

const fx = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "planner", "fixtures");
const report = JSON.parse(readFileSync(join(fx, "sample_optimizer.report.json"), "utf8"));

test("with no saved run the panel says not yet generated and shows no numbers", () => {
  const v = buildOptimizerView(null);
  assert.equal(v.status, "not_yet_generated");
  assert.equal(v.tables.length, 0);
});

test("the panel shows the saved run's ranking and naive comparison row for row", () => {
  const v = buildOptimizerView(report);
  assert.equal(v.tables[0].rows.length, report.ranking.length);
  assert.equal(v.tables[1].rows.length, report.naive_comparison.length);
  assert.equal(v.tables[0].rows[0][1], report.ranking[0]);
});

test("the panel says it is a sample run, simulated and not a proven optimum", () => {
  const v = buildOptimizerView(report);
  const text = v.notes.map((n) => n.text).join(" ");
  assert.match(text, /Sample run/);
  assert.match(text, /not measured/);
  assert.match(text, /not a proven optimum/);
});

test("the best layout in the summary is the report's best", () => {
  const v = buildOptimizerView(report);
  assert.match(v.summary[0][1], new RegExp(`^${report.best}, \\d+ anchors`));
});
