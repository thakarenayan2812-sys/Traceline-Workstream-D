// D8 integration tests (no browser). Wiring between the page and the code, the predictor's inputs, a full run,
// reproducibility of the stand-ins, and the offline rule (no remote host is contacted by shipped code).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { createHash } from "node:crypto";
import { validateVenue } from "../../planner/src/core/validate.js";
import { loadVenue, validateReplay } from "../../planner/src/adapters/scenario_adapter.js";
import { createMockPredictor } from "../../planner/src/adapters/inference_adapter.js";
import { normalizeAnalytics } from "../../planner/src/adapters/analytics_adapter.js";
import { applyControls } from "../src/engine/controls.js";
import { runScenario } from "../src/engine/scenario_runner.js";
import { buildAnalyticsStandin, DEFAULT_SEED } from "../../planner/tools/make_analytics_standin.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const demo = join(root, "demo");
const fx = join(root, "planner", "fixtures");
const read = (p) => readFileSync(p, "utf8");
const venue = JSON.parse(read(join(fx, "venue_office_standin.json")));
const replay = JSON.parse(read(join(fx, "replay_office_standin.json")));
const standin = JSON.parse(read(join(fx, "analytics.stand_in.json")));

test("the stand-in venue and replay pass their validators", () => {
  assert.deepEqual(validateVenue(venue), []);
  assert.deepEqual(validateReplay(replay), []);
  assert.equal(venue.anchors.length, 6);
});

test("loadVenue refuses a venue that breaks the contract", async () => {
  const bad = { ...venue, anchors: venue.anchors.slice(0, 1).map((a) => ({ ...a, anchor_id: "x" })) };
  await assert.rejects(loadVenue("bad", async () => ({ json: async () => bad })), /Invalid venue/);
});

test("every element id the script looks up exists in the page", () => {
  const html = read(join(demo, "index.html"));
  const js = read(join(demo, "src", "main.js"));
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const looked = [...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(looked.length > 20, "the script looks up many ids");
  const missing = [...new Set(looked)].filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
});

test("labels and ARIA references in the page point at real ids", () => {
  const html = read(join(demo, "index.html"));
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...html.matchAll(/\s(for|aria-labelledby|aria-describedby)="([^"]+)"/g)]
    .flatMap((m) => m[2].split(/\s+/));
  const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...refs, ...hrefs].filter((r) => !ids.has(r)), []);
});

test("every local file the page loads exists", () => {
  const html = read(join(demo, "index.html"));
  const files = [...html.matchAll(/\s(?:src|href)="([^"#][^"]*)"/g)].map((m) => m[1])
    .filter((f) => !f.startsWith("data:") && !f.startsWith("http"));
  assert.ok(files.length >= 2);
  for (const f of files) assert.ok(statSync(join(demo, f)).isFile(), f);
});

test("the predictor only ever receives measurements, never truth", () => {
  const predictor = createMockPredictor();
  const seen = [];
  const inner = predictor.predict.bind(predictor);
  predictor.predict = async (input) => { seen.push(input); return inner(input); };
  const scenario = applyControls(venue, replay, {});
  return runScenario(predictor, venue, scenario).then(() => {
    assert.ok(seen.length === replay.steps.length);
    const allowedTop = new Set(["slots", "previous_position_valid", "x_prev_m", "y_prev_m", "dt_s", "state"]);
    const allowedSlot = new Set(["anchor_id", "x_m", "y_m", "range_m", "rssi_dbm", "valid_flag"]);
    for (const input of seen) {
      for (const k of Object.keys(input)) assert.ok(allowedTop.has(k), `unexpected input key ${k}`);
      assert.equal(input.slots.length, 8);
      for (const s of input.slots) for (const k of Object.keys(s)) assert.ok(allowedSlot.has(k), `unexpected slot key ${k}`);
    }
    const text = JSON.stringify(seen);
    assert.ok(!text.includes('"truth"') && !text.includes('"is_nlos"') && !text.includes('"bias_m"'));
  });
});

test("a full run covers every step and is identical when repeated", async () => {
  const scenario = applyControls(venue, replay, { noise_multiplier: 2, extra_dropout: 0.2, seed: 7 });
  const a = await runScenario(createMockPredictor(), venue, scenario);
  const b = await runScenario(createMockPredictor(), venue, applyControls(venue, replay, { noise_multiplier: 2, extra_dropout: 0.2, seed: 7 }));
  assert.equal(a.length, replay.steps.length);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  for (const o of a) {
    assert.ok(Number.isFinite(o.estimate.x_m) && Number.isFinite(o.estimate.y_m));
    assert.ok(o.valid_anchors <= 8);
  }
});

test("the analytics stand-in is the seeded output of its generator, and its manifest matches the file", () => {
  assert.deepEqual(buildAnalyticsStandin(venue, DEFAULT_SEED), standin);
  const manifest = JSON.parse(read(join(fx, "analytics.stand_in.manifest.json")));
  const sha = createHash("sha256").update(readFileSync(join(fx, "analytics.stand_in.json"))).digest("hex");
  assert.equal(manifest.output_sha256, sha);
  assert.equal(manifest.seed, DEFAULT_SEED);
});

test("the stand-in is labelled as a stand-in in every section", () => {
  assert.equal(standin.stand_in, true);
  const n = normalizeAnalytics(standin);
  for (const sec of Object.values(n)) assert.equal(sec.status, "stand_in");
  assert.ok(standin.caveats[0].startsWith("STAND-IN"));
});

test("the shipped code and page contact no remote host (offline rule)", () => {
  const scan = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if ([".js", ".html", ".css"].includes(extname(p))) scan.push(p);
    }
  };
  walk(join(demo, "src"));
  walk(join(root, "planner", "src"));
  scan.push(join(demo, "index.html"), join(root, "planner", "index.html"));
  const offenders = [];
  for (const f of scan) {
    for (const m of read(f).matchAll(/https?:\/\/[^\s"'`)]*/g)) {
      if (!m[0].startsWith("http://localhost") && !m[0].startsWith("http://127.0.0.1")) offenders.push(`${f}: ${m[0]}`);
    }
  }
  assert.ok(scan.length > 15, "the scan covers the shipped code");
  assert.deepEqual(offenders, []);
});
