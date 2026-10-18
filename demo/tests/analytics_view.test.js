// D8 analytics panels: view models built from C's JSON (or the stand-in). Pure, no browser.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildAnalyticsViews, summariseViews, missingFields, STRESS_MIN_CONDITIONS, STATUS_TEXT } from "../src/panels/analytics_view.js";

const fx = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "planner", "fixtures");
const standin = JSON.parse(readFileSync(join(fx, "analytics.stand_in.json"), "utf8"));
const byId = (views) => Object.fromEntries(views.map((v) => [v.id, v]));
const stats = (n, median_m, p90_m) => ({ n, median_m, p90_m });

/** A complete, valid C-style document. Override individual sections in tests. */
function doc(over = {}) {
  const base = {
    error_map: { status: "ok", data: {
      cell_size_m: 2, support_threshold: 5, split: "train 1-6, dev 7-8",
      before: stats(100, 1.8, 3.5), after: stats(100, 1.5, 3.0),
      cells: [{ x_m: 2, y_m: 2, n_obs: 9, mean_residual_m: 0.2 }, { x_m: 4, y_m: 2, n_obs: 2, mean_residual_m: 0.1 }],
    } },
    crowd_degradation: { status: "ok", data: {
      zones: [{ zone_id: "lobby", density_people_m2: 2, inside: { n: 50, median_m: 2, p90_m: 3.9, sigma_m_mean: 0.8 }, outside: { n: 60, median_m: 1.4, p90_m: 2.5, sigma_m_mean: 0.6 } }],
      crowd_input: { with_crowd: stats(120, 1.5, 2.8), without_crowd: stats(120, 1.7, 3.1) },
    } },
    stress: { status: "ok", data: {
      conditions_run: 5000, failure_threshold_m: 2, failure_rate: 0.12,
      grid: { x_axis: "anchor count", y_axis: "noise", x_labels: ["3", "4"], y_labels: ["1x", "2x"], values: [[0.1, 0.2], [0.3, 0.4]] },
    } },
    emergency_flags: { status: "ok", data: {
      threshold_sigma_m: 1, error_threshold_m: 2, total_steps: 120, flagged_steps: 10, high_error_steps: 20,
      true_flags: 6, precision: 0.6, recall: 0.3,
    } },
  };
  return { ...base, ...over };
}

test("with no analytics file every section says not yet generated and shows no numbers", () => {
  const views = buildAnalyticsViews(null);
  assert.equal(views.length, 4);
  for (const v of views) {
    assert.equal(v.status, "not_yet_generated");
    assert.equal(v.statusText, STATUS_TEXT.not_yet_generated);
    assert.equal(v.summary.length, 0);
    assert.equal(v.tables.length, 0);
    assert.equal(v.notes.length, 0);
  }
});

test("the stand-in file builds all four panels as stand-ins, with the file's caveats", () => {
  const views = buildAnalyticsViews(standin);
  assert.deepEqual(views.map((v) => v.id), ["error_map", "crowd_degradation", "stress", "emergency_flags"]);
  for (const v of views) {
    assert.equal(v.status, "stand_in");
    assert.equal(v.statusText, STATUS_TEXT.stand_in);
    assert.ok(v.caveats.length >= 2, `${v.id} keeps the stand-in caveats`);
    assert.ok(v.caveats[0].startsWith("STAND-IN"));
  }
  assert.equal(summariseViews(views), "4 stand-in");
});

test("a section with no usable data is not_yet_generated, the others still build", () => {
  const views = byId(buildAnalyticsViews(doc({ stress: { status: "not_yet_generated", data: null } })));
  assert.equal(views.stress.status, "not_yet_generated");
  assert.equal(views.error_map.status, "ok");
  assert.equal(summariseViews(Object.values(views)), "3 from C's output, 1 not yet generated");
});

test("an unknown status is treated as not yet generated, never shown as ok", () => {
  const views = byId(buildAnalyticsViews(doc({ emergency_flags: { status: "done", data: { total_steps: 1 } } })));
  assert.equal(views.emergency_flags.status, "not_yet_generated");
});

test("ok output carries no stand-in caveats and is labelled as C's", () => {
  const views = byId(buildAnalyticsViews(doc({ caveats: ["should not appear for ok output"] })));
  assert.equal(views.error_map.statusText, STATUS_TEXT.ok);
  assert.deepEqual(views.error_map.caveats, []);
});

test("malformed data is marked incomplete and names the missing fields", () => {
  const bad = doc({ error_map: { status: "ok", data: { cell_size_m: 2, support_threshold: 5, split: "x", before: stats(1, 1, 1), cells: [] } } });
  const v = byId(buildAnalyticsViews(bad)).error_map;
  assert.equal(v.status, "incomplete");
  assert.match(v.statusText, /missing after/);
  assert.equal(v.tables.length, 0, "no numbers from incomplete data");
  assert.deepEqual(missingFields("error_map", bad.error_map.data), ["after"]);
});

test("a stress grid whose shape does not match its labels is incomplete", () => {
  const d = doc().stress.data;
  d.grid.values = [[0.1]];
  assert.deepEqual(missingFields("stress", d), ["grid"]);
});

test("error map claims improvement only when median and P90 are both lower", () => {
  const better = byId(buildAnalyticsViews(doc())).error_map;
  assert.match(better.notes[0].text, /both lower after learning/);
  assert.equal(better.notes[0].level, "info");

  const worseP90 = doc({ error_map: { status: "ok", data: { ...doc().error_map.data, after: stats(100, 1.5, 3.9) } } });
  const v = byId(buildAnalyticsViews(worseP90)).error_map;
  assert.equal(v.notes[0].level, "warn");
  assert.match(v.notes[0].text, /Do not claim one/);
});

test("error map reports no comparison when a run has no points", () => {
  const d = doc({ error_map: { status: "ok", data: { ...doc().error_map.data, after: stats(0, 0, 0) } } });
  const v = byId(buildAnalyticsViews(d)).error_map;
  assert.match(v.notes[0].text, /no comparison is possible/);
});

test("error map counts cells below the support threshold", () => {
  const v = byId(buildAnalyticsViews(doc())).error_map;
  const row = v.summary.find(([k]) => k.startsWith("Cells below"));
  assert.equal(row[1], "1");
});

test("crowd panel reports honestly when crowd input did not help", () => {
  const d = doc({ crowd_degradation: { status: "ok", data: { ...doc().crowd_degradation.data,
    crowd_input: { with_crowd: stats(120, 1.9, 3.0), without_crowd: stats(120, 1.7, 2.9) } } } });
  const v = byId(buildAnalyticsViews(d)).crowd_degradation;
  assert.match(v.notes[0].text, /did not lower error/);
});

test("crowd panel lists every zone with inside and outside columns", () => {
  const v = byId(buildAnalyticsViews(doc())).crowd_degradation;
  assert.equal(v.tables[0].rows.length, 1);
  assert.equal(v.tables[0].rows[0][0], "lobby");
  assert.equal(v.tables[0].headers.length, v.tables[0].rows[0].length);
});

test("stress panel warns below 5,000 conditions and never calls it a stress-test result", () => {
  const few = doc({ stress: { status: "ok", data: { ...doc().stress.data, conditions_run: 0, failure_rate: null } } });
  const v = byId(buildAnalyticsViews(few)).stress;
  assert.equal(STRESS_MIN_CONDITIONS, 5000);
  assert.equal(v.notes[0].level, "warn");
  assert.match(v.notes[0].text, /not a stress-test result/);
  assert.equal(v.summary.find(([k]) => k === "Failure rate")[1], "n/a");

  const enough = byId(buildAnalyticsViews(doc())).stress;
  assert.equal(enough.notes.length, 0);
  assert.equal(enough.tables[0].rows[0][1], "10%");
});

test("emergency panel flags precision that does not match its counts", () => {
  const off = doc({ emergency_flags: { status: "ok", data: { ...doc().emergency_flags.data, precision: 0.9 } } });
  const v = byId(buildAnalyticsViews(off)).emergency_flags;
  assert.ok(v.notes.some((n) => n.level === "warn" && /Precision does not match/.test(n.text)));
});

test("emergency panel accepts null precision when nothing was flagged, and always says it is not a safety system", () => {
  const none = doc({ emergency_flags: { status: "ok", data: { ...doc().emergency_flags.data, flagged_steps: 0, true_flags: 0, precision: null } } });
  const v = byId(buildAnalyticsViews(none)).emergency_flags;
  assert.ok(!v.notes.some((n) => n.level === "warn"));
  assert.ok(v.notes.some((n) => /Not a clinical or safety system/.test(n.text)));
});

test("stand-in precision and recall agree with the stand-in counts", () => {
  const d = standin.emergency_flags.data;
  assert.equal(d.precision, Number((d.true_flags / d.flagged_steps).toFixed(3)));
  assert.equal(d.recall, Number((d.true_flags / d.high_error_steps).toFixed(3)));
});
