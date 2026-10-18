// Scenario controls (guide 15: "controls must alter the scenario, not just labels").
// The recorded replay supplies the TRUE path and the recorded readings. Each control transforms those
// readings deterministically (seeded), and every changed reading keeps an honest label:
//   active anchors   : anchors beyond the first N (by anchor_id) stop reporting at all
//   noise multiplier : total range noise sigma is multiplied by m (extra noise drawn with a seed)
//   extra dropout    : an additional share of readings is lost (null), on top of the recorded ones
//   obstruction bias : the recorded NLOS bias is scaled by s (0 removes it, 1 keeps it, 2 doubles it)
//   crowd density    : people/m2 applied to every crowd zone, using the stand-in crowd placeholders
// Nothing here reads the NLOS label to decide the estimate: it only changes readings. Labels stay for diagnostics.
import { STAND_IN_CROWD_EFFECTS, STAND_IN_SIGNAL, crowdDensityAt } from "../../../planner/src/adapters/simulator_adapter.js";
import { DT_S } from "../../../planner/src/core/constants.js";

export const DEFAULT_CONTROLS = Object.freeze({
  active_anchors: null,   // null = all anchors in the venue
  noise_multiplier: 1,
  extra_dropout: 0,
  obstruction_scale: 1,
  crowd_density: 0,
  seed: 1,
});

export const CONTROL_LIMITS = Object.freeze({
  active_anchors: [3, 8], noise_multiplier: [1, 3], extra_dropout: [0, 0.5], obstruction_scale: [0, 2], crowd_density: [0, 4],
});

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/** Integer hash (same finaliser style as the planner's simulator) so each reading has its own stream. */
function mix(...keys) {
  let h = 0x9e3779b9;
  for (const k of keys) { h ^= Math.imul(k | 0, 0x85ebca6b); h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35); h ^= h >>> 16; }
  return h >>> 0;
}
function uniforms(seed, k, anchorId, n) {
  let a = mix(seed, k, anchorId, 99) || 1;
  const out = [];
  for (let i = 0; i < n; i++) { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); out.push(((t ^ (t >>> 14)) >>> 0) / 4294967296); }
  return out;
}

/** Validated, clamped copy of the controls. Unknown keys are dropped. */
export function normaliseControls(venue, c = {}) {
  const n = venue.anchors.length;
  const lim = { ...CONTROL_LIMITS, active_anchors: [Math.min(3, n), n] };
  const merged = { ...DEFAULT_CONTROLS, ...c };
  return {
    active_anchors: clamp(Math.round(merged.active_anchors ?? n), lim.active_anchors),
    noise_multiplier: clamp(Number(merged.noise_multiplier), lim.noise_multiplier),
    extra_dropout: clamp(Number(merged.extra_dropout), lim.extra_dropout),
    obstruction_scale: clamp(Number(merged.obstruction_scale), lim.obstruction_scale),
    crowd_density: clamp(Number(merged.crowd_density), lim.crowd_density),
    seed: Number.isInteger(merged.seed) ? merged.seed : 1,
  };
}

/** Anchors that are switched on for a given count: the first N enabled anchors by id. */
export function activeAnchors(venue, count) {
  return venue.anchors.filter((a) => a.enabled !== false).sort((a, b) => a.anchor_id - b.anchor_id).slice(0, count);
}

/**
 * Apply the controls to the recorded replay.
 * @returns {{controls, anchors, steps: {k, t, truth, readings:{anchor_id,range_m,rssi_dbm}[], labels:{anchor_id,is_nlos,bias_m,lost}[]}[]}}
 *          Readings include only active anchors. `labels` are for diagnostics and never go to the predictor.
 */
export function applyControls(venue, replay, rawControls = {}) {
  const c = normaliseControls(venue, rawControls);
  const anchors = activeAnchors(venue, c.active_anchors);
  const crowdZones = (venue.zones ?? []).filter((z) => z.zone_type === "crowd")
    .map((z) => ({ zone_id: z.zone_id, polygon: z.polygon, density_people_m2: c.crowd_density }));
  const sigmaA = STAND_IN_SIGNAL.range_sigma_a_m, sigmaB = STAND_IN_SIGNAL.range_sigma_b;
  const steps = replay.steps.map((s) => {
    const truth = { x: s.truth.x_m, y: s.truth.y_m };
    const density = c.crowd_density > 0 ? crowdDensityAt(crowdZones, truth) : 0;
    const readings = [], labels = [];
    for (const a of anchors) {
      const rec = s.readings.find((r) => r.anchor_id === a.anchor_id);
      if (!rec) { readings.push({ anchor_id: a.anchor_id, range_m: null, rssi_dbm: null }); labels.push({ anchor_id: a.anchor_id, is_nlos: false, bias_m: 0, lost: true }); continue; }
      const d = Math.hypot(truth.x - a.x_m, truth.y - a.y_m);
      const recordedLost = rec.range_m == null;
      const [u0, u1] = uniforms(c.seed, s.k, a.anchor_id, 2);
      const crowdSigma = 1 + STAND_IN_CROWD_EFFECTS.sigma_per_density * density;
      const totalScale = c.noise_multiplier * crowdSigma;
      // Recorded noise already has sigma0; add independent noise so the total is sigma0 x totalScale.
      const sigma0 = sigmaA + sigmaB * d;
      const extraSigma = sigma0 * Math.sqrt(Math.max(0, totalScale * totalScale - 1));
      const gz = Math.sqrt(-2 * Math.log(1 - u0)) * Math.cos(2 * Math.PI * u1);
      const extraLoss = Math.min(1, c.extra_dropout + STAND_IN_CROWD_EFFECTS.loss_per_density * density);
      const [u2] = uniforms(c.seed, s.k, a.anchor_id + 1000, 1);
      const lost = recordedLost || u2 < extraLoss;
      const bias = rec.is_nlos ? (rec.bias_m ?? 0) : 0;
      const base = recordedLost ? 0 : rec.range_m - bias * (1 - c.obstruction_scale);
      const range = recordedLost ? null : Math.max(0, base + gz * extraSigma);
      readings.push({ anchor_id: a.anchor_id, range_m: lost ? null : round3(range), rssi_dbm: lost ? null : rec.rssi_dbm });
      labels.push({ anchor_id: a.anchor_id, is_nlos: !!rec.is_nlos, bias_m: round3(bias * c.obstruction_scale), lost });
    }
    return { k: s.k, t: s.t, truth, readings, labels };
  });
  return { controls: c, anchors, steps, dt_s: replay.dt_s ?? DT_S };
}

const round3 = (v) => Math.round(v * 1000) / 1000;
