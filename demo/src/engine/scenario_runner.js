// Runs the predictor (mock or real, through the inference adapter) over a scenario, one step at a time.
// The predictor and the baselines see measurements only. Truth is attached afterwards, for scoring in the UI.
import { DT_S } from "../../../planner/src/core/constants.js";
import { buildModelInput, flagOutOfBounds } from "../../../planner/src/adapters/inference_adapter.js";
import { validatePredictorOutput } from "../../../planner/src/core/validate.js";
import { suspectedNlosAnchors } from "./diagnostics.js";
import { b1, b2 } from "./baselines.js";

/**
 * @param scenario output of applyControls: {anchors, steps}
 * @returns per-step outputs: {k, estimate, sigma_m, out_of_bounds, predicted, suspected_nlos, valid_anchors,
 *          reason_text, reason_codes, nlos_probability, baselines:{b1, b2}, truth}
 */
export async function runScenario(predictor, venue, scenario) {
  if (!predictor) throw new RangeError("runScenario needs a predictor.");
  predictor.reset?.();
  const stepVenue = { ...venue, anchors: scenario.anchors };
  const out = [];
  let prev = null, state = null;
  for (const s of scenario.steps) {
    const input = buildModelInput(stepVenue, s.readings, prev, DT_S, state);
    const raw = await predictor.predict(input);
    const problems = validatePredictorOutput(raw);
    if (problems.length) throw new Error(`Predictor output rejected at step ${s.k}: ${problems.join(" ")}`);
    const o = flagOutOfBounds(raw, venue); // flagged, never clamped (guide 10.3)
    const slots = input.slots.filter((x) => x.valid_flag === 1).map((x) => ({ x_m: x.x_m, y_m: x.y_m, range_m: x.range_m }));
    out.push({
      k: s.k,
      truth: s.truth,
      estimate: { x_m: o.x_hat_m, y_m: o.y_hat_m },
      sigma_m: o.sigma_m,
      out_of_bounds: o.reason_codes.includes("OUT_OF_BOUNDS"),
      predicted: o.predicted_positions.map((p) => ({ x_m: p.x_m, y_m: p.y_m })),
      suspected_nlos: suspectedNlosAnchors(input, raw),
      nlos_probability: raw.nlos_probability_by_anchor,
      slot_anchor_ids: input.slots.map((x) => x.anchor_id),
      valid_anchors: slots.length,
      reason_text: o.reason_text,
      reason_codes: o.reason_codes,
      baselines: { b1: b1(slots), b2: b2(slots) },
    });
    prev = { x_hat_m: o.x_hat_m, y_hat_m: o.y_hat_m };
    state = raw.state_out ?? null;
  }
  return out;
}
