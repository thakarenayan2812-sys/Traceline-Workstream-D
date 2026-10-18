// Diagnostics and warning state (guide 15 D7: estimate, uncertainty, valid anchors, suspected NLOS, reason, horizon, warning).
import { errorStats } from "../../../planner/src/plan/optimizer.js";

export const UNCERTAIN_SIGMA_M = 1.0;  // demo threshold for an "uncertain" warning. Not calibrated (guide 10.2).
export const SUSPECT_NLOS_P = 0.5;     // a slot counts as suspected obstructed above this probability

/** Warning level in plain words. Order matters: the first condition that holds wins. */
export function warningState({ outside, valid_anchors, sigma_m, suspected_nlos }) {
  if (outside) return { level: "outside", text: "Estimate is outside the venue. It is flagged, not moved onto the map." };
  if (valid_anchors < 3) return { level: "low_coverage", text: `Only ${valid_anchors} valid anchor reading(s). The position is held or uncertain.` };
  if (sigma_m > UNCERTAIN_SIGMA_M) return { level: "uncertain", text: `Uncertainty ${sigma_m.toFixed(2)} m is above ${UNCERTAIN_SIGMA_M} m. Treat this position as uncertain.` };
  if (suspected_nlos.length >= 2) return { level: "caution", text: `${suspected_nlos.length} anchors look obstructed; the estimate may be biased.` };
  return { level: "ok", text: "Readings agree within the expected uncertainty." };
}

/** Anchor ids whose predicted NLOS probability is above the threshold, from the model's slot order. */
export function suspectedNlosAnchors(input, output) {
  return input.slots.map((s, i) => ({ id: s.anchor_id, p: output.nlos_probability_by_anchor[i] }))
    .filter((s) => s.id !== null && s.p > SUSPECT_NLOS_P).map((s) => s.id);
}

/** Running error summary over the played part of the replay. */
export const runningError = (errs) => errorStats(errs);
