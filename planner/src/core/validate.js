// Lightweight client-side checks mirroring guide 9.1 and 9.3.
// The authoritative validator is shared/validate_contracts.py (not ours).
import { MAX_ANCHOR_SLOTS, ZONE_TYPES } from "./constants.js";

const VENUE_KEYS = ["schema_version", "venue_id", "width_m", "height_m",
  "anchors", "walls", "obstacles", "zones", "metadata"];

/** @returns {string[]} human-readable problems; empty array means valid. */
export function validateVenue(v) {
  const errs = [];
  if (!v || typeof v !== "object") return ["Venue is not an object."];
  for (const k of VENUE_KEYS) if (!(k in v)) errs.push(`Missing key: ${k}`);
  if (errs.length) return errs;
  if (!(v.width_m > 0 && v.height_m > 0)) errs.push("width_m and height_m must be positive.");
  if (v.anchors.length > MAX_ANCHOR_SLOTS) errs.push(`More than ${MAX_ANCHOR_SLOTS} anchors defined.`);
  const ids = new Set();
  v.anchors.forEach((a, i) => {
    if (!Number.isInteger(a.anchor_id)) errs.push(`Anchor ${i}: anchor_id must be an integer.`);
    if (ids.has(a.anchor_id)) errs.push(`Anchor ${i}: duplicate anchor_id ${a.anchor_id}.`);
    ids.add(a.anchor_id);
    if (a.x_m < 0 || a.y_m < 0 || a.x_m > v.width_m || a.y_m > v.height_m)
      errs.push(`Anchor ${a.anchor_id}: outside venue bounds.`);
  });
  v.walls.forEach((w) => {
    for (const k of ["x1_m", "y1_m", "x2_m", "y2_m"])
      if (!Number.isFinite(w[k])) errs.push(`Wall ${w.wall_id}: ${k} is not a number.`);
  });
  v.zones.forEach((z) => {
    if (!ZONE_TYPES.includes(z.zone_type)) errs.push(`Zone ${z.zone_id}: bad zone_type.`);
    if (!Array.isArray(z.polygon) || z.polygon.length < 3) errs.push(`Zone ${z.zone_id}: polygon needs 3+ vertices.`);
  });
  return errs;
}

/** Checks a canonical model output object (guide 9.3). */
export function validatePredictorOutput(o) {
  const errs = [];
  const need = ["x_hat_m", "y_hat_m", "sigma_m", "nlos_probability_by_anchor", "predicted_positions",
    "state_out", "confidence", "used_anchor_ids", "downweighted_anchor_ids", "reason_codes", "reason_text"];
  for (const k of need) if (!(k in o)) errs.push(`Missing output key: ${k}`);
  if (errs.length) return errs;
  for (const k of ["x_hat_m", "y_hat_m", "sigma_m"])
    if (!Number.isFinite(o[k])) errs.push(`${k} must be finite.`);
  if (o.nlos_probability_by_anchor.length !== MAX_ANCHOR_SLOTS)
    errs.push(`nlos_probability_by_anchor must have ${MAX_ANCHOR_SLOTS} slots.`);
  return errs;
}
