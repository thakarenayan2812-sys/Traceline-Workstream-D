// D8: turns Workstream C's analytics JSON into panel view models. Pure: no DOM, no fetch, no clock.
// The layouts are D's proposal (planner/schemas/STAND_IN_FORMATS.md, "Analytics"). C confirms or changes them.
// Honesty rules (guide 10.2, 11, 14): a section is never shown with numbers it does not contain, improvement is
// only claimed when measured, and a stress test below 5,000 conditions is labelled as not a stress-test result.
import { ANALYTICS_SECTIONS, normalizeAnalytics } from "../../../planner/src/adapters/analytics_adapter.js";

export const STRESS_MIN_CONDITIONS = 5000;
export const PRECISION_TOL = 1e-3;
export const STATUS_TEXT = Object.freeze({
  ok: "From C's output",
  stand_in: "Stand-in values, not C's output",
  not_yet_generated: "Not yet generated",
  incomplete: "Not yet generated (data incomplete)",
});
const TITLES = Object.freeze({
  error_map: "Error map: before and after self-learning",
  crowd_degradation: "Crowd degradation",
  stress: "Automatic stress test",
  emergency_flags: "Emergency flags",
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isStr = (v) => typeof v === "string" && v.length > 0;
const isStats = (s) => !!s && isCount(s.n) && isNum(s.median_m) && isNum(s.p90_m);
const pct = (v) => (isNum(v) ? `${(v * 100).toFixed(0)}%` : "n/a");
const metres = (v) => (isNum(v) ? `${v.toFixed(2)} m` : "n/a");
const ratio = (v) => (isNum(v) ? v.toFixed(3) : "n/a");

// Required fields per section: name -> predicate. Missing or wrong-typed fields make the section "incomplete".
const REQUIRED = Object.freeze({
  error_map: {
    cell_size_m: (v) => isNum(v) && v > 0,
    support_threshold: (v) => isCount(v) && v >= 1,
    split: isStr,
    before: isStats,
    after: isStats,
    cells: Array.isArray,
  },
  crowd_degradation: {
    zones: Array.isArray,
    crowd_input: (v) => !!v && isStats(v.with_crowd) && isStats(v.without_crowd),
  },
  stress: {
    conditions_run: isCount,
    failure_threshold_m: (v) => isNum(v) && v > 0,
    failure_rate: (v) => v === null || (isNum(v) && v >= 0 && v <= 1),
    grid: (g) => !!g && isStr(g.x_axis) && isStr(g.y_axis) && Array.isArray(g.x_labels) && Array.isArray(g.y_labels)
      && Array.isArray(g.values) && g.values.length === g.y_labels.length
      && g.values.every((row) => Array.isArray(row) && row.length === g.x_labels.length),
  },
  emergency_flags: {
    threshold_sigma_m: (v) => isNum(v) && v > 0,
    total_steps: (v) => isCount(v) && v >= 1,
    flagged_steps: isCount,
    high_error_steps: isCount,
    true_flags: isCount,
    precision: (v) => v === null || (isNum(v) && v >= 0 && v <= 1),
    recall: (v) => v === null || (isNum(v) && v >= 0 && v <= 1),
  },
});

/** Pure. Names of required fields that are missing or malformed. */
export function missingFields(id, data) {
  const spec = REQUIRED[id];
  if (!data || typeof data !== "object") return ["data"];
  return Object.keys(spec).filter((k) => !spec[k](data[k]));
}

const base = (id, status, extra = {}) => ({
  id, title: TITLES[id], status, statusText: STATUS_TEXT[status] ?? STATUS_TEXT.not_yet_generated,
  caveats: [], summary: [], tables: [], notes: [], ...extra,
});
// notes: [{level: "info" | "warn", text}]. The renderer prefixes warnings with "Warning:" so colour is not the only cue.
const note = (level, text) => ({ level, text });

function errorMapView(d, status) {
  const v = base("error_map", status, { caveats: [] });
  const belowSupport = d.cells.filter((c) => isCount(c.n_obs) && c.n_obs < d.support_threshold).length;
  v.summary = [
    ["Split", d.split],
    ["Cell size", metres(d.cell_size_m)],
    ["Cells", String(d.cells.length)],
    [`Cells below ${d.support_threshold} observations (not corrected)`, String(belowSupport)],
  ];
  v.tables = [{
    caption: "Held-out error before and after self-learning",
    headers: ["Run", "Points", "Median", "P90"],
    rows: [
      ["Before", String(d.before.n), metres(d.before.median_m), metres(d.before.p90_m)],
      ["After", String(d.after.n), metres(d.after.median_m), metres(d.after.p90_m)],
    ],
  }];
  if (d.before.n === 0 || d.after.n === 0) {
    v.notes.push(note("warn", "No held-out points in one of the runs, so no comparison is possible."));
  } else if (d.after.median_m < d.before.median_m && d.after.p90_m <= d.before.p90_m) {
    v.notes.push(note("info", "Measured on the held-out split: median and P90 are both lower after learning."));
  } else {
    v.notes.push(note("warn", "No measured improvement on the held-out split. Do not claim one."));
  }
  return v;
}

function crowdView(d, status) {
  const v = base("crowd_degradation", status);
  v.summary = [["Crowd zones", String(d.zones.length)]];
  v.tables = [
    {
      caption: "Error inside and outside each crowd zone",
      headers: ["Zone", "Density (people/m²)", "Inside n", "Inside median", "Inside P90", "Outside n", "Outside median", "Outside P90"],
      rows: d.zones.map((z) => [
        String(z.zone_id), isNum(z.density_people_m2) ? String(z.density_people_m2) : "n/a",
        String(z.inside.n), metres(z.inside.median_m), metres(z.inside.p90_m),
        String(z.outside.n), metres(z.outside.median_m), metres(z.outside.p90_m),
      ]),
    },
    {
      caption: "Crowd input with and without crowd zones (same runs)",
      headers: ["Model input", "Points", "Median", "P90"],
      rows: [
        ["With crowd input", String(d.crowd_input.with_crowd.n), metres(d.crowd_input.with_crowd.median_m), metres(d.crowd_input.with_crowd.p90_m)],
        ["Without crowd input", String(d.crowd_input.without_crowd.n), metres(d.crowd_input.without_crowd.median_m), metres(d.crowd_input.without_crowd.p90_m)],
      ],
    },
  ];
  const w = d.crowd_input.with_crowd, o = d.crowd_input.without_crowd;
  if (w.n === 0 || o.n === 0) v.notes.push(note("warn", "No points for one of the crowd-input runs, so no comparison is possible."));
  else if (w.median_m < o.median_m && w.p90_m <= o.p90_m) v.notes.push(note("info", "On these runs, crowd input lowered median and P90 error."));
  else v.notes.push(note("info", "On these runs, crowd input did not lower error. The result is reported as it is."));
  return v;
}

function stressView(d, status) {
  const v = base("stress", status);
  v.summary = [
    ["Conditions run", String(d.conditions_run)],
    ["Failure threshold", metres(d.failure_threshold_m)],
    ["Failure rate", pct(d.failure_rate)],
  ];
  v.tables = [{
    caption: `Failure rate by ${d.grid.y_axis} (rows) and ${d.grid.x_axis} (columns)`,
    headers: ["", ...d.grid.x_labels.map(String)],
    rows: d.grid.y_labels.map((label, i) => [String(label), ...d.grid.values[i].map((x) => pct(x))]),
  }];
  if (d.conditions_run < STRESS_MIN_CONDITIONS) {
    v.notes.push(note("warn", `Fewer than ${STRESS_MIN_CONDITIONS.toLocaleString("en-GB")} conditions were run (guide 10.2). This is not a stress-test result.`));
  }
  return v;
}

function emergencyView(d, status) {
  const v = base("emergency_flags", status);
  v.summary = [
    ["Uncertainty flag threshold (1 sigma)", metres(d.threshold_sigma_m)],
    ["Error counted as high", metres(d.error_threshold_m ?? null)],
    ["Steps", String(d.total_steps)],
    ["Flagged steps", String(d.flagged_steps)],
    ["Steps with high error", String(d.high_error_steps)],
    ["Flags that matched high error", String(d.true_flags)],
    ["Precision (flags that were right)", ratio(d.precision)],
    ["Recall (high-error steps flagged)", ratio(d.recall)],
  ];
  const expected = d.flagged_steps ? d.true_flags / d.flagged_steps : null;
  if ((expected === null) !== (d.precision === null) || (expected !== null && Math.abs(expected - d.precision) > PRECISION_TOL)) {
    v.notes.push(note("warn", "Precision does not match the counts. Check C's export before showing it."));
  }
  v.notes.push(note("info", "Prioritisation view only. Flags mean uncertain, not confirmed errors. Not a clinical or safety system."));
  return v;
}

const BUILDERS = { error_map: errorMapView, crowd_degradation: crowdView, stress: stressView, emergency_flags: emergencyView };

/**
 * Pure. raw = whatever was loaded (or null). Always returns one view per section, in the order of ANALYTICS_SECTIONS.
 * @returns {Array<{id,title,status,statusText,caveats,summary,tables,notes}>}
 */
export function buildAnalyticsViews(raw) {
  const normal = normalizeAnalytics(raw);
  const docCaveats = raw && Array.isArray(raw.caveats) ? raw.caveats.filter((c) => typeof c === "string") : [];
  return ANALYTICS_SECTIONS.map((id) => {
    const sec = normal[id];
    if (sec.status === "not_yet_generated") return base(id, "not_yet_generated");
    const missing = missingFields(id, sec.data);
    if (missing.length) {
      const v = base(id, "incomplete");
      v.statusText = `${STATUS_TEXT.incomplete}: missing ${missing.join(", ")}`;
      return v;
    }
    const view = BUILDERS[id](sec.data, sec.status);
    if (sec.status === "stand_in") view.caveats = [...docCaveats];
    return view;
  });
}

/** Pure. A one-line count for the system status list, e.g. "2 stand-in, 2 not yet generated". */
export function summariseViews(views) {
  const n = (s) => views.filter((v) => v.status === s).length;
  const parts = [["ok", "from C's output"], ["stand_in", "stand-in"], ["incomplete", "incomplete"], ["not_yet_generated", "not yet generated"]]
    .filter(([s]) => n(s) > 0).map(([s, label]) => `${n(s)} ${label}`);
  return parts.join(", ") || "none";
}
