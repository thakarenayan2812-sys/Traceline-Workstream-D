// Inference adapter. The UI only ever talks to a "predictor":
//   { name, is_mock, reset(), predict(input) -> Promise<output> }
// Input and output follow guide section 9.3. B's infer.js will implement the same
// interface, so swapping the mock for the real model is a file swap (see createPredictor).
import { MAX_ANCHOR_SLOTS, DT_S } from "../core/constants.js";
import { inBounds } from "../core/transforms.js";

/**
 * Build the model input for one time step from raw readings.
 * Reads ONLY measurements, anchor coordinates and the previous estimate.
 * It never touches truth or NLOS labels, by construction.
 * Missing readings: valid_flag 0 with null values (never -1, 0 or 999).
 */
export function buildModelInput(venue, readings, prevEstimate, dt_s = DT_S, state = null) {
  const byId = new Map(readings.map((r) => [r.anchor_id, r]));
  const anchors = venue.anchors
    .filter((a) => a.enabled !== false)
    .sort((a, b) => a.anchor_id - b.anchor_id)
    .slice(0, MAX_ANCHOR_SLOTS);
  const slots = [];
  for (let i = 0; i < MAX_ANCHOR_SLOTS; i++) {
    const a = anchors[i];
    if (!a) {
      slots.push({ anchor_id: null, x_m: null, y_m: null, range_m: null, rssi_dbm: null, valid_flag: 0 });
      continue;
    }
    const r = byId.get(a.anchor_id);
    const ok = r && Number.isFinite(r.range_m);
    slots.push({
      anchor_id: a.anchor_id, x_m: a.x_m, y_m: a.y_m,
      range_m: ok ? r.range_m : null,
      rssi_dbm: r && Number.isFinite(r.rssi_dbm) ? r.rssi_dbm : null,
      valid_flag: ok ? 1 : 0,
    });
  }
  const prevOk = !!prevEstimate && Number.isFinite(prevEstimate.x_hat_m);
  return {
    slots,
    previous_position_valid: prevOk ? 1 : 0,
    x_prev_m: prevOk ? prevEstimate.x_hat_m : null,
    y_prev_m: prevOk ? prevEstimate.y_hat_m : null,
    dt_s,
    state,
  };
}

/** Flag (never clamp) estimates outside venue bounds. Returns a new object. */
export function flagOutOfBounds(output, venue) {
  const out = { ...output, reason_codes: [...output.reason_codes] };
  if (!inBounds({ x: output.x_hat_m, y: output.y_hat_m }, venue)) {
    out.reason_codes.push("OUT_OF_BOUNDS");
    out.reason_text += " Estimate is outside the venue bounds.";
  }
  return out;
}

/**
 * MOCK predictor: plain Gauss-Newton least-squares trilateration on valid slots.
 * It is NOT the Traceline model. Values it reports for sigma and NLOS are crude
 * residual-based stand-ins so the UI contract can be built and tested.
 *  - sigma_m: RMS range residual (floor 0.3 m). Not calibrated.
 *  - nlos probability: logistic of each anchor's absolute residual. Not learned.
 *  - confidence: null, because no tested meaning exists yet (guide 10.2).
 */
export function createMockPredictor() {
  return {
    name: "mock-trilateration",
    is_mock: true,
    reset() {},
    async predict(input) {
      const valid = input.slots.map((s, i) => ({ s, i })).filter(({ s }) => s.valid_flag === 1);
      const nlos = new Array(MAX_ANCHOR_SLOTS).fill(0);
      const base = { nlos_probability_by_anchor: nlos, confidence: null, predicted_positions: [] };

      if (valid.length < 3) {
        const havePrev = input.previous_position_valid === 1;
        const pos = havePrev
          ? { x: input.x_prev_m, y: input.y_prev_m }
          : valid.length
            ? { x: avg(valid.map((v) => v.s.x_m)), y: avg(valid.map((v) => v.s.y_m)) }
            : { x: 0, y: 0 };
        return finish(base, pos, 10, input, valid.map((v) => v.s.anchor_id), [],
          ["MOCK_PREDICTOR", "TOO_FEW_ANCHORS"],
          `Only ${valid.length} valid anchor(s); position held from the previous step (mock).`);
      }

      let x = avg(valid.map((v) => v.s.x_m));
      let y = avg(valid.map((v) => v.s.y_m));
      for (let it = 0; it < 20; it++) {
        let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
        for (const { s } of valid) {
          const dx = x - s.x_m, dy = y - s.y_m;
          const d = Math.max(Math.hypot(dx, dy), 1e-6);
          const jx = dx / d, jy = dy / d, r = s.range_m - d;
          a11 += jx * jx; a12 += jx * jy; a22 += jy * jy;
          b1 += jx * r; b2 += jy * r;
        }
        const det = a11 * a22 - a12 * a12;
        if (Math.abs(det) < 1e-9) break;
        x += (a22 * b1 - a12 * b2) / det;
        y += (a11 * b2 - a12 * b1) / det;
      }
      let sq = 0;
      const down = [];
      for (const { s, i } of valid) {
        const r = Math.abs(s.range_m - Math.hypot(x - s.x_m, y - s.y_m));
        sq += r * r;
        nlos[i] = 1 / (1 + Math.exp(-(r - 1.0) / 0.4));
        if (nlos[i] > 0.5) down.push(s.anchor_id);
      }
      const sigma = Math.max(0.3, Math.sqrt(sq / valid.length));
      const used = valid.map((v) => v.s.anchor_id).filter((id) => !down.includes(id));
      const codes = ["MOCK_PREDICTOR", ...down.map(() => "ANCHOR_DOWNWEIGHTED")];
      const text = down.length
        ? `Anchor ${down.join(", ")} down-weighted, likely obstructed (mock estimate).`
        : "All valid anchors agree (mock estimate).";
      return finish(base, { x, y }, sigma, input, used, down, codes, text);
    },
  };
}

function finish(base, pos, sigma, input, used, down, codes, text) {
  // Constant-velocity forecast (4 steps) from the previous estimate. Mock only.
  const havePrev = input.previous_position_valid === 1;
  const vx = havePrev ? (pos.x - input.x_prev_m) / input.dt_s : 0;
  const vy = havePrev ? (pos.y - input.y_prev_m) / input.dt_s : 0;
  const predicted = [1, 2, 3, 4].map((k) => ({
    x_m: pos.x + vx * input.dt_s * k, y_m: pos.y + vy * input.dt_s * k,
  }));
  return {
    ...base,
    x_hat_m: pos.x, y_hat_m: pos.y, sigma_m: sigma,
    predicted_positions: predicted,
    state_out: { vx, vy },
    used_anchor_ids: used, downweighted_anchor_ids: down,
    reason_codes: codes, reason_text: text,
  };
}

const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/**
 * Single swap point. When B delivers model/infer.js, pass its factory here:
 *   createPredictor({ real: () => import("../../../model/infer.js").then(m => m.createPredictor()) })
 * Until then the mock is returned. The UI must show predictor.is_mock in its badge.
 */
export async function createPredictor({ real = null } = {}) {
  if (real) {
    try { return await real(); } catch { /* fall through to mock, UI shows the badge */ }
  }
  return createMockPredictor();
}
