// Loads venue and replay JSON. Replay shape is a D-defined stand-in (see schemas/STAND_IN_FORMATS.md);
// A's real replay fixtures should be mapped into it here, not in the UI.
import { validateVenue } from "../core/validate.js";

/** @returns {Promise<object>} venue, or throws an Error listing every problem. */
export async function loadVenue(url, fetchFn = fetch) {
  const v = await (await fetchFn(url)).json();
  const errs = validateVenue(v);
  if (errs.length) throw new Error("Invalid venue: " + errs.join(" "));
  return v;
}

/** Pure check of a replay object. */
export function validateReplay(r) {
  const errs = [];
  if (!r || !Array.isArray(r.steps) || r.steps.length === 0) return ["Replay has no steps."];
  r.steps.forEach((s, i) => {
    if (!Number.isFinite(s.t)) errs.push(`Step ${i}: t missing.`);
    if (!Array.isArray(s.readings)) errs.push(`Step ${i}: readings missing.`);
  });
  return errs.slice(0, 10);
}

export async function loadReplay(url, fetchFn = fetch) {
  const r = await (await fetchFn(url)).json();
  const errs = validateReplay(r);
  if (errs.length) throw new Error("Invalid replay: " + errs.join(" "));
  return r;
}
