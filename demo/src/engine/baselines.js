// Classical baselines for the B1/B2 comparison panel. These are DEMO STAND-INS so the panel can run; the real
// B1/B2/B3 are workstream B's (model/). B3 (Kalman) is not implemented here and is reported as "not yet generated".
// Slots: [{x_m, y_m, range_m}] for valid readings only. Coordinates in metres.
import { sigmaForRange } from "./noise_model.js";

const RESIDUAL_REJECT_M = 1.0; // B2 demo threshold, reported in the panel

/** Gauss-Newton weighted least squares, weights 1 / sigma(range)^2. Returns {x_m, y_m} or null with fewer than 3 slots. */
export function weightedLeastSquares(slots) {
  if (slots.length < 3) return null;
  let x = slots.reduce((s, a) => s + a.x_m, 0) / slots.length;
  let y = slots.reduce((s, a) => s + a.y_m, 0) / slots.length;
  for (let it = 0; it < 25; it++) {
    let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
    for (const s of slots) {
      const dx = x - s.x_m, dy = y - s.y_m, d = Math.max(Math.hypot(dx, dy), 1e-6);
      const w = 1 / sigmaForRange(s.range_m) ** 2, jx = dx / d, jy = dy / d, r = s.range_m - d;
      a11 += w * jx * jx; a12 += w * jx * jy; a22 += w * jy * jy; b1 += w * jx * r; b2 += w * jy * r;
    }
    const det = a11 * a22 - a12 * a12;
    if (Math.abs(det) < 1e-12) break;
    const dxStep = (a22 * b1 - a12 * b2) / det, dyStep = (a11 * b2 - a12 * b1) / det;
    x += dxStep; y += dyStep;
    if (Math.hypot(dxStep, dyStep) < 1e-7) break;
  }
  return Number.isFinite(x) && Number.isFinite(y) ? { x_m: x, y_m: y } : null;
}

/** B1: weighted least squares on all valid slots. */
export function b1(slots) {
  const p = weightedLeastSquares(slots);
  return p && { x_m: p.x_m, y_m: p.y_m, used: slots.length, rejected: 0 };
}

/** B2: B1, then drop slots whose residual exceeds RESIDUAL_REJECT_M and solve again (if at least 3 remain). */
export function b2(slots) {
  const first = weightedLeastSquares(slots);
  if (!first) return null;
  const kept = slots.filter((s) => Math.abs(s.range_m - Math.hypot(first.x_m - s.x_m, first.y_m - s.y_m)) <= RESIDUAL_REJECT_M);
  if (kept.length < 3 || kept.length === slots.length) return { x_m: first.x_m, y_m: first.y_m, used: slots.length, rejected: 0 };
  const second = weightedLeastSquares(kept);
  return second && { x_m: second.x_m, y_m: second.y_m, used: kept.length, rejected: slots.length - kept.length };
}

export const BASELINE_NOTES = Object.freeze({
  b1: "Weighted least squares (demo stand-in for B1).",
  b2: `Weighted least squares after rejecting slots whose residual exceeds ${RESIDUAL_REJECT_M} m (demo stand-in for B2).`,
  b3: "Not yet generated: B3 (extended Kalman filter after B2) is workstream B's and is not in the demo.",
});
