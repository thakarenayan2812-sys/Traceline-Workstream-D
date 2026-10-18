// D8 stand-in for Workstream C's analytics JSON. The demo panels read it through src/adapters/analytics_adapter.js.
//
// EVERY NUMBER IN THIS FILE IS A SEEDED PLACEHOLDER. Nothing was measured, simulated, trained or scored.
// The file says so in its caveats, and every panel labels it as a stand-in. C replaces this file with real output
// through the same adapter; no panel code changes.
//
// Usage: node tools/make_analytics_standin.js [seed]     (default seed 4242; same seed, same JSON)
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rng } from "../src/core/rng.js";

const here = dirname(fileURLToPath(import.meta.url));
const FX = join(here, "..", "fixtures");
export const SCHEMA_VERSION = "d8-proposed-layout-0.1";
export const DEFAULT_SEED = 4242;

/** Pure given (venue, seed). Returns the stand-in analytics object (not written to disk). */
export function buildAnalyticsStandin(venue, seed = DEFAULT_SEED) {
  const r = rng(seed);
  const between = (a, b, d = 2) => +(a + (b - a) * r()).toFixed(d);
  const pick = (n) => Math.min(n - 1, Math.floor(r() * n));

  // Error map: before and after self-learning, on a held-out split (placeholder counts and errors).
  const cellSize = 2.0;
  const cells = [];
  for (let x = 2; x <= Math.max(2, venue.width_m - 2); x += 2 * cellSize) {
    for (let y = 2; y <= Math.max(2, venue.height_m - 2); y += 2 * cellSize) {
      cells.push({ x_m: x, y_m: y, n_obs: 2 + pick(12), mean_residual_m: between(-0.6, 0.9) });
    }
  }
  const errorMap = {
    cell_size_m: cellSize,
    support_threshold: 5,
    split: "placeholder split: train runs 1-6, dev runs 7-8 (not C's split)",
    before: { n: 240, median_m: between(1.2, 2.0), p90_m: between(2.6, 4.0) },
    after: { n: 240, median_m: between(1.0, 2.2), p90_m: between(2.2, 4.2) },
    cells,
  };

  // Crowd degradation: one entry per crowd zone of the venue, plus with/without crowd input.
  const crowdZones = (venue.zones ?? []).filter((z) => z.zone_type === "crowd");
  const densities = [1, 2, 3];
  const stats = (lo, hi) => ({ n: 40 + pick(80), median_m: between(lo, hi), p90_m: between(lo * 2, hi * 2), sigma_m_mean: between(0.4, 1.2) });
  const crowd = {
    zones: crowdZones.map((z, i) => ({
      zone_id: z.zone_id,
      density_people_m2: densities[i % densities.length],
      inside: stats(1.3, 2.3),
      outside: stats(1.1, 2.0),
    })),
    crowd_input: {
      with_crowd: { n: 240, median_m: between(1.1, 2.0), p90_m: between(2.4, 4.0) },
      without_crowd: { n: 240, median_m: between(1.1, 2.0), p90_m: between(2.4, 4.0) },
    },
  };

  // Stress test: placeholder grid only. conditions_run is 0 because no stress run exists yet.
  const stress = {
    conditions_run: 0,
    failure_threshold_m: 2.0,
    failure_rate: null,
    grid: {
      x_axis: "anchor count",
      y_axis: "range noise multiplier",
      x_labels: ["3", "4", "5", "6", "8"],
      y_labels: ["1x", "2x", "3x"],
      values: [0, 1, 2].map(() => [0, 1, 2, 3, 4].map(() => +between(0, 1).toFixed(2))),
    },
  };

  // Emergency flags: counts are internally consistent (precision and recall follow from the counts).
  const total = 120, highError = 18 + pick(12), flagged = 14 + pick(16);
  const truePos = Math.min(flagged, highError, 6 + pick(10));
  const emergency = {
    threshold_sigma_m: 1.0,
    error_threshold_m: 2.0,
    total_steps: total,
    flagged_steps: flagged,
    high_error_steps: highError,
    true_flags: truePos,
    precision: flagged ? +(truePos / flagged).toFixed(3) : null,
    recall: highError ? +(truePos / highError).toFixed(3) : null,
  };

  return {
    schema_version: SCHEMA_VERSION,
    stand_in: true,
    seed,
    generator: "planner/tools/make_analytics_standin.js",
    caveats: [
      "STAND-IN. Every number is a seeded placeholder, not a measurement, simulation or score.",
      "Written by Workstream D so the panels can be built and tested. Workstream C replaces it with real output.",
      "The layouts are D's proposal (planner/schemas/STAND_IN_FORMATS.md). C confirms or changes them.",
    ],
    error_map: { status: "stand_in", data: errorMap },
    crowd_degradation: { status: "stand_in", data: crowd },
    stress: { status: "stand_in", data: stress },
    emergency_flags: { status: "stand_in", data: emergency },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seed = Number(process.argv[2] ?? DEFAULT_SEED);
  const venue = JSON.parse(readFileSync(join(FX, "venue_office_standin.json"), "utf8"));
  const doc = buildAnalyticsStandin(venue, seed);
  const text = JSON.stringify(doc, null, 2) + "\n";
  writeFileSync(join(FX, "analytics.stand_in.json"), text);
  const manifest = {
    script: "tools/make_analytics_standin.js",
    seed,
    schema_version: SCHEMA_VERSION,
    output_sha256: createHash("sha256").update(text).digest("hex"),
    note: "Placeholder values. Not measured results.",
  };
  writeFileSync(join(FX, "analytics.stand_in.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote fixtures/analytics.stand_in.json (seed ${seed}, stand-in values).`);
}
