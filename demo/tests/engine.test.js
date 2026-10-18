// D7 engine tests (no browser). Scenario controls, playback, baselines, warnings and the predictor's inputs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyControls, normaliseControls, DEFAULT_CONTROLS } from "../src/engine/controls.js";
import { createPlayback, tick, seek, stepBy, setSpeed, toggle, play, speed } from "../src/engine/playback.js";
import { b1, b2, weightedLeastSquares } from "../src/engine/baselines.js";
import { warningState, suspectedNlosAnchors } from "../src/engine/diagnostics.js";
import { runScenario } from "../src/engine/scenario_runner.js";
import { createMockPredictor } from "../../planner/src/adapters/inference_adapter.js";
import { DT_S } from "../../planner/src/core/constants.js";

const fx = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "planner", "fixtures");
const venue = JSON.parse(readFileSync(join(fx, "venue_office_standin.json"), "utf8"));
const replay = JSON.parse(readFileSync(join(fx, "replay_office_standin.json"), "utf8"));
const dist = (s, a) => Math.hypot(s.truth.x - a.x_m, s.truth.y - a.y_m);

test("with default controls the recorded readings are reproduced exactly", () => {
  const sc = applyControls(venue, replay, {});
  assert.equal(sc.anchors.length, venue.anchors.length);
  sc.steps.forEach((s, k) => {
    replay.steps[k].readings.forEach((rec, i) => {
      assert.equal(s.readings[i].range_m, rec.range_m, `step ${k} anchor ${rec.anchor_id}`);
      assert.equal(s.readings[i].rssi_dbm, rec.rssi_dbm);
    });
  });
});

test("controls are clamped to their limits and unknown values fall back to defaults", () => {
  const c = normaliseControls(venue, { active_anchors: 99, noise_multiplier: 0.1, extra_dropout: 2, obstruction_scale: -1, crowd_density: 9 });
  assert.equal(c.active_anchors, venue.anchors.length);
  assert.equal(c.noise_multiplier, 1); assert.equal(c.extra_dropout, 0.5); assert.equal(c.obstruction_scale, 0); assert.equal(c.crowd_density, 4);
  assert.equal(normaliseControls(venue, { active_anchors: 1 }).active_anchors, 3, "never fewer than 3 anchors");
  assert.equal(normaliseControls(venue, {}).noise_multiplier, DEFAULT_CONTROLS.noise_multiplier);
});

test("active anchor count removes the other anchors from every step", () => {
  const sc = applyControls(venue, replay, { active_anchors: 4 });
  assert.equal(sc.anchors.length, 4);
  for (const s of sc.steps) assert.deepEqual(s.readings.map((r) => r.anchor_id), sc.anchors.map((a) => a.anchor_id));
});

test("obstruction scale 0 removes the recorded NLOS bias and labels it", () => {
  const sc = applyControls(venue, replay, { obstruction_scale: 0 });
  let checked = 0;
  sc.steps.forEach((s, k) => replay.steps[k].readings.forEach((rec, i) => {
    if (!rec.is_nlos || rec.range_m == null) return;
    checked++;
    assert.ok(Math.abs(s.readings[i].range_m - (rec.range_m - rec.bias_m)) < 1e-3, "bias removed");
    assert.equal(s.labels[i].bias_m, 0);
    assert.equal(s.labels[i].is_nlos, true, "the obstruction label is kept for diagnostics");
  }));
  assert.ok(checked > 0, "the replay has NLOS readings to test");
});

test("higher noise multiplier gives a larger spread of range error around the true distance", () => {
  const spread = (m) => {
    const sc = applyControls(venue, replay, { noise_multiplier: m, obstruction_scale: 0 });
    const errs = [];
    sc.steps.forEach((s) => s.readings.forEach((r, i) => { if (r.range_m != null) errs.push(r.range_m - dist(s, sc.anchors[i])); }));
    const mu = errs.reduce((a, b) => a + b, 0) / errs.length;
    return Math.sqrt(errs.reduce((a, b) => a + (b - mu) ** 2, 0) / errs.length);
  };
  assert.ok(spread(3) > spread(1.5) && spread(1.5) > spread(1), "spread grows with the multiplier");
});

test("extra dropout raises the share of missing readings monotonically, and is seeded", () => {
  const nulls = (d, seed = 1) => {
    const sc = applyControls(venue, replay, { extra_dropout: d, seed });
    const all = sc.steps.flatMap((s) => s.readings);
    return all.filter((r) => r.range_m == null).length / all.length;
  };
  assert.ok(nulls(0.4) > nulls(0.2) && nulls(0.2) > nulls(0));
  assert.deepEqual(applyControls(venue, replay, { extra_dropout: 0.3 }), applyControls(venue, replay, { extra_dropout: 0.3 }));
  assert.notDeepEqual(applyControls(venue, replay, { extra_dropout: 0.3, seed: 2 }).steps, applyControls(venue, replay, { extra_dropout: 0.3, seed: 1 }).steps);
});

test("crowd density changes readings inside the crowd zone (controls alter the scenario)", () => {
  const base = applyControls(venue, replay, {});
  const crowd = applyControls(venue, replay, { crowd_density: 4 });
  const changed = base.steps.some((s, k) => s.readings.some((r, i) => r.range_m !== crowd.steps[k].readings[i].range_m));
  assert.ok(changed);
});

test("playback advances by speed x wall time, stops at the end, and clamps seek and steps", () => {
  let s = play(createPlayback(120));          // 1x
  s = tick(s, 1.0);                           // 1 s of replay = 2 steps
  assert.equal(s.index, Math.round(1 / DT_S));
  s = setSpeed(s, 4);                         // 4x
  assert.equal(speed(s), 4);
  s = tick(s, 0.5);                           // 2 s more of replay = 4 steps
  assert.equal(s.index, 2 + 4);
  assert.equal(tick(toggle(s), 10).playing, false, "paused: no advance");
  const end = tick(play(seek(createPlayback(10), 8)), 60);
  assert.equal(end.index, 9); assert.equal(end.playing, false, "pauses at the last step");
  assert.equal(seek(createPlayback(10), 99).index, 9);
  assert.equal(stepBy(createPlayback(10), -5).index, 0);
  assert.equal(setSpeed(createPlayback(10), 99).speedIndex, 4);
  assert.throws(() => createPlayback(0), RangeError);
});

test("weighted least squares recovers an exact position and B2 rejects a bad residual", () => {
  const p = { x: 5, y: 3 };
  const anchors = [[0, 0], [10, 0], [0, 8], [10, 8], [5, 0]];
  const slots = anchors.map(([x, y]) => ({ x_m: x, y_m: y, range_m: Math.hypot(p.x - x, p.y - y) }));
  const solved = weightedLeastSquares(slots);
  assert.ok(Math.abs(solved.x_m - 5) < 1e-3 && Math.abs(solved.y_m - 3) < 1e-3);
  assert.equal(weightedLeastSquares(slots.slice(0, 2)), null, "fewer than 3 slots gives no answer");
  const bad = slots.map((s, i) => (i === 4 ? { ...s, range_m: s.range_m + 4 } : s));
  const r2 = b2(bad);
  assert.equal(r2.rejected, 1);
  assert.ok(Math.abs(r2.x_m - 5) < 0.05 && Math.abs(r2.y_m - 3) < 0.05, "B2 recovers after rejecting the bad anchor");
  assert.equal(b1(slots).rejected, 0);
});

test("warning order: outside, then low coverage, then uncertain, then caution, then ok", () => {
  const base = { outside: false, valid_anchors: 5, sigma_m: 0.4, suspected_nlos: [] };
  assert.equal(warningState({ ...base, outside: true }).level, "outside");
  assert.equal(warningState({ ...base, valid_anchors: 2 }).level, "low_coverage");
  assert.equal(warningState({ ...base, sigma_m: 1.5 }).level, "uncertain");
  assert.equal(warningState({ ...base, suspected_nlos: [1, 2] }).level, "caution");
  assert.equal(warningState(base).level, "ok");
});

test("the predictor's inputs contain measurements only, and runScenario covers every step", async () => {
  const sc = applyControls(venue, replay, { obstruction_scale: 1 });
  const seen = [];
  const spy = { name: "spy", is_mock: true, reset() {}, async predict(input) { seen.push(input); return createMockPredictor().predict(input); } };
  const out = await runScenario(spy, venue, sc);
  assert.equal(out.length, replay.steps.length);
  const allowedSlot = new Set(["anchor_id", "x_m", "y_m", "range_m", "rssi_dbm", "valid_flag"]);
  for (const input of seen) for (const s of input.slots) assert.ok(Object.keys(s).every((k) => allowedSlot.has(k)));
  assert.ok(out.every((o) => Number.isFinite(o.estimate.x_m) && Number.isFinite(o.estimate.y_m)));
  assert.ok(out.every((o) => o.baselines.b1 === null || Number.isFinite(o.baselines.b1.x_m)));
});

test("suspected NLOS uses the model's probabilities, not the recorded labels", () => {
  const input = { slots: [{ anchor_id: 0 }, { anchor_id: 1 }, { anchor_id: null }] };
  assert.deepEqual(suspectedNlosAnchors(input, { nlos_probability_by_anchor: [0.9, 0.2, 0.99, 0, 0, 0, 0, 0] }), [0]);
});
