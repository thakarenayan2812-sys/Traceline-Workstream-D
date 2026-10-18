import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { validateVenue, validatePredictorOutput } from "../src/core/validate.js";
import { buildModelInput, createMockPredictor, createPredictor, flagOutOfBounds } from "../src/adapters/inference_adapter.js";
import { normalizeAnalytics, loadAnalytics } from "../src/adapters/analytics_adapter.js";
import { validateReplay } from "../src/adapters/scenario_adapter.js";
import { generate } from "../tools/make_sample_replay.js";

const fx = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const venue = JSON.parse(readFileSync(join(fx, "venue_office_standin.json"), "utf8"));
const replay = generate(venue, 4242);

test("stand-in venue is valid and a broken one is rejected", () => {
  assert.deepEqual(validateVenue(venue), []);
  const bad = structuredClone(venue); bad.anchors[0].x_m = 99; delete bad.metadata;
  assert.ok(validateVenue(bad).length >= 1);
});

test("replay generation is deterministic per seed", () => {
  assert.deepEqual(generate(venue, 4242), replay);
  assert.notDeepEqual(generate(venue, 7).steps[3].readings, replay.steps[3].readings);
  assert.deepEqual(validateReplay(replay), []);
});

test("replay has NLOS and missing readings, with null (not sentinel) for missing", () => {
  const all = replay.steps.flatMap((s) => s.readings);
  assert.ok(all.some((r) => r.is_nlos), "expected some NLOS readings");
  assert.ok(all.some((r) => r.range_m === null), "expected some packet loss");
  assert.ok(!all.some((r) => r.range_m === -1 || r.range_m === 999));
});

test("model input never carries truth or labels, and pads to 8 slots", () => {
  const step = replay.steps[10];
  const input = buildModelInput(venue, step.readings, null);
  const text = JSON.stringify(input);
  assert.ok(!/is_nlos|bias_m|truth/.test(text));
  assert.equal(input.slots.length, 8);
  assert.equal(input.slots[6].valid_flag, 0);          // padding slot
  assert.equal(input.previous_position_valid, 0);      // first step
  assert.equal(input.dt_s, 0.5);
});

test("missing reading gives valid_flag 0 with null values", () => {
  const readings = replay.steps[0].readings.map((r, i) => i === 2 ? { ...r, range_m: null, rssi_dbm: null } : r);
  const s = buildModelInput(venue, readings, null).slots[2];
  assert.equal(s.valid_flag, 0); assert.equal(s.range_m, null);
});

test("mock predictor returns a valid canonical output on every replay step", async () => {
  const p = await createPredictor();
  assert.ok(p.is_mock);
  let prev = null;
  for (const step of replay.steps) {
    const out = await p.predict(buildModelInput(venue, step.readings, prev));
    assert.deepEqual(validatePredictorOutput(out), []);
    assert.equal(out.confidence, null);
    prev = out;
  }
});

test("mock predictor recovers an exact position from noise-free ranges, and survives < 3 anchors", async () => {
  const p = createMockPredictor();
  const truth = { x: 14, y: 7 };
  const exact = venue.anchors.map((a) => ({
    anchor_id: a.anchor_id, range_m: Math.hypot(truth.x - a.x_m, truth.y - a.y_m), rssi_dbm: -60,
  }));
  const out = await p.predict(buildModelInput(venue, exact, null));
  assert.ok(Math.hypot(out.x_hat_m - truth.x, out.y_hat_m - truth.y) < 0.01);
  assert.deepEqual(out.downweighted_anchor_ids, []);
  const sparse = exact.map((r, i) => i < 2 ? r : { ...r, range_m: null, rssi_dbm: null });
  const out2 = await p.predict(buildModelInput(venue, sparse, { x_hat_m: 5, y_hat_m: 5 }));
  assert.ok(out2.reason_codes.includes("TOO_FEW_ANCHORS"));
  assert.deepEqual(validatePredictorOutput(out2), []);
});

test("mock predictor flags a strongly biased anchor", async () => {
  const p = createMockPredictor();
  const truth = { x: 14, y: 7 };
  const rs = venue.anchors.map((a) => ({
    anchor_id: a.anchor_id, range_m: Math.hypot(truth.x - a.x_m, truth.y - a.y_m) + (a.anchor_id === 1 ? 3 : 0), rssi_dbm: -60,
  }));
  const out = await p.predict(buildModelInput(venue, rs, null));
  assert.ok(out.nlos_probability_by_anchor[1] > out.nlos_probability_by_anchor[0]);
});

test("out-of-bounds estimates are flagged, not clamped", () => {
  const o = flagOutOfBounds({ x_hat_m: 99, y_hat_m: 5, reason_codes: [], reason_text: "x." }, venue);
  assert.equal(o.x_hat_m, 99);
  assert.ok(o.reason_codes.includes("OUT_OF_BOUNDS"));
});

test("analytics: missing or malformed input becomes not_yet_generated", async () => {
  for (const raw of [null, {}, { error_map: { status: "ok" } }, { stress: { status: "weird", data: 1 } }]) {
    const n = normalizeAnalytics(raw);
    assert.equal(n.error_map.status, "not_yet_generated");
    assert.equal(n.stress.status, "not_yet_generated");
  }
  const ok = normalizeAnalytics({ error_map: { status: "stand_in", data: { cells: [] } } });
  assert.equal(ok.error_map.status, "stand_in");
  const failing = await loadAnalytics("x", async () => { throw new Error("offline"); });
  assert.equal(failing.crowd_degradation.status, "not_yet_generated");
});
