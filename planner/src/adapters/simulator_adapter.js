// Simulator adapter (D6). A STAND-IN for workstream A's simulator (sim/js). It does two things:
//   1. makeEvaluationSet: seeded ground-truth walks through the walkable area (truth is scoring-only).
//   2. simulateReadings: range / RSSI readings for ANY anchor layout, computed from the same truth path.
// Readings and truth are returned in separate objects. The predictor only ever receives readings
// (anchor_id, range_m, rssi_dbm); labels (is_nlos, bias_m) are returned apart, for diagnostics only.
//
// Noise draws are keyed by (seed, trajectory, step, CANDIDATE index), not by the order of anchors in a
// layout. Two layouts that share an anchor therefore see the same noise on that anchor, so differences
// between layouts come from geometry, not from the random stream (common random numbers).
//
// The numbers below are guide section 8 starting values, copied here for the stand-in only. Source of
// truth is shared/signal_model.json (owned by A), which was not available. Crowd effects are a PLACEHOLDER
// monotonic formula in the same spirit as guide section 8, pending A's formula.
import { DT_S } from "../core/constants.js";
import { rng } from "../core/rng.js";
import { buildGrid, lineOfSight, pointInPolygon, distance } from "../core/geometry.js";

export const STAND_IN_SIGNAL = Object.freeze({
  range_sigma_a_m: 0.15,      // sigma_range = a + b * true_distance
  range_sigma_b: 0.02,
  rssi_ref_dbm: -40,          // rssi = -40 - 20 log10(max(d, 0.5)) + N(0, 2.5)
  rssi_sigma_dbm: 2.5,
  nlos_bias_lo_m: 0.5,        // blocked line of sight adds a positive bias, uniform in [lo, hi]
  nlos_bias_hi_m: 3.0,
  packet_loss: 0.05,          // per anchor per step
});

export const STAND_IN_CROWD_EFFECTS = Object.freeze({
  sigma_per_density: 0.1,     // range noise x (1 + 0.1 * density), density in people/m2
  loss_per_density: 0.02,     // added packet loss per person/m2
  max_loss: 0.5,              // cap on total packet loss in a crowd
  nlos_per_density: 0.05,     // chance per reading of a body-induced NLOS bias, per person/m2 (capped at 1)
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Integer hash (murmur-style finaliser) so that nearby keys give unrelated streams. */
function mix(...keys) {
  let h = 0x9e3779b9;
  for (const k of keys) {
    h ^= Math.imul(k | 0, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/** Walkable cell centres at a resolution, in row order. Same rule as the coverage grid (guide 9.4). */
export function walkableCentres(venue, resolution_m) {
  const grid = buildGrid(venue, resolution_m, { boundary: venue.metadata?.walkable_boundary_m ?? null, obstacles: venue.obstacles ?? [] });
  const out = [];
  for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) if (grid.walkable[j * grid.nx + i]) out.push(grid.cellCenter(i, j));
  if (!out.length) throw new RangeError("There is no walkable area to simulate a person in. Check the floor boundary.");
  return out;
}

/** Crowd density at a point: the highest density of any crowd zone containing it (0 outside all zones). */
export function crowdDensityAt(zones, pt) {
  let d = 0;
  for (const z of zones) if (z.density_people_m2 > d && pointInPolygon(pt, z.polygon) !== "outside") d = z.density_people_m2;
  return d;
}

/**
 * Seeded ground-truth walks. A walk picks a random walkable cell centre within `walk_radius_m` whose
 * straight line from the current position is clear of walls and obstacles, walks to it at `speed_mps`,
 * and repeats. Positions are sampled every DT_S. The same seed always gives the same walks.
 * @returns {{seed:number, dt_s:number, speed_mps:number, walk_radius_m:number, resolution_m:number,
 *            trajectories: {traj:number, truth:{x:number,y:number}[]}[]}}
 */
export function makeEvaluationSet(venue, { seed = 1, trajectories = 3, steps = 360, speed_mps = 1.0, walk_radius_m = 15, resolution_m = 1 } = {}) {
  if (!Number.isInteger(trajectories) || trajectories < 1) throw new RangeError("Trajectories must be a whole number, 1 or more.");
  if (!Number.isInteger(steps) || steps < 2) throw new RangeError("Steps per trajectory must be a whole number, 2 or more.");
  if (!isNum(speed_mps) || speed_mps <= 0) throw new RangeError("Walking speed must be a positive number of metres per second.");
  const cells = walkableCentres(venue, resolution_m);
  const out = [];
  for (let t = 0; t < trajectories; t++) {
    const r = rng(mix(seed, t, 1));
    const pick = () => cells[Math.floor(r() * cells.length)];
    const nextTarget = (from) => {
      for (let tries = 0; tries < 80; tries++) {
        const c = pick(), d = distance(from, c);
        if (d >= 1 && d <= walk_radius_m && !lineOfSight(from, c, venue).blocked) return c;
      }
      return null;
    };
    let pos = pick(), target = null;
    const truth = [];
    for (let k = 0; k < steps; k++) {
      truth.push({ x: pos.x, y: pos.y });
      let remain = speed_mps * DT_S;
      while (remain > 1e-12) {
        if (!target) target = nextTarget(pos);
        if (!target) break; // nowhere clear to go: stand still this step
        const d = distance(pos, target);
        if (d <= remain) { pos = target; remain -= d; target = null; }
        else { const f = remain / d; pos = { x: pos.x + (target.x - pos.x) * f, y: pos.y + (target.y - pos.y) * f }; remain = 0; }
      }
    }
    out.push({ traj: t, truth });
  }
  return { seed, dt_s: DT_S, speed_mps, walk_radius_m, resolution_m, trajectories: out };
}

/**
 * Readings for one layout over the whole evaluation set.
 * @param layout [{anchor_id, x_m, y_m, candidate_index}]
 * @param crowdZones zones from crowdZonesFromVenue (density per zone); [] means no crowd effects
 * @returns {{readings: {anchor_id, range_m|null, rssi_dbm|null}[][][], labels: {anchor_id, is_nlos, bias_m, lost}[][][]}[]}
 *          indexed as [trajectory][step][reading]. Missing readings are null, never sentinels.
 */
export function simulateReadings(venue, evalSet, layout, { seed = evalSet.seed, crowdZones = [], crowdEffects = STAND_IN_CROWD_EFFECTS, signal = STAND_IN_SIGNAL } = {}) {
  return evalSet.trajectories.map(({ traj, truth }) => {
    const readings = [], labels = [];
    truth.forEach((pos, k) => {
      const density = crowdZones.length ? crowdDensityAt(crowdZones, pos) : 0;
      const sigmaScale = 1 + crowdEffects.sigma_per_density * density;
      const lossP = Math.min(crowdEffects.max_loss, signal.packet_loss + crowdEffects.loss_per_density * density);
      const rs = [], ls = [];
      for (const a of layout) {
        // Seven uniforms in a fixed order per (seed, trajectory, step, candidate). Keep this order stable.
        const r = rng(mix(seed, traj, k, a.candidate_index, 7));
        const u = [r(), r(), r(), r(), r(), r(), r()];
        const d = Math.hypot(pos.x - a.x_m, pos.y - a.y_m);
        const blocked = lineOfSight({ x: a.x_m, y: a.y_m }, pos, venue).blocked;
        const bodyNlos = density > 0 && u[4] < Math.min(1, crowdEffects.nlos_per_density * density);
        const nlos = blocked || bodyNlos;
        const bias = nlos ? signal.nlos_bias_lo_m + (signal.nlos_bias_hi_m - signal.nlos_bias_lo_m) * u[3] : 0;
        const gz = Math.sqrt(-2 * Math.log(1 - u[0])) * Math.cos(2 * Math.PI * u[1]);
        const gr = Math.sqrt(-2 * Math.log(1 - u[5])) * Math.cos(2 * Math.PI * u[6]);
        const sigma = (signal.range_sigma_a_m + signal.range_sigma_b * d) * sigmaScale;
        const lost = u[2] < lossP;
        const range = Math.max(0, d + gz * sigma + bias);
        const rssi = signal.rssi_ref_dbm - 20 * Math.log10(Math.max(d, 0.5)) + gr * signal.rssi_sigma_dbm;
        rs.push({ anchor_id: a.anchor_id, range_m: lost ? null : Math.round(range * 1000) / 1000, rssi_dbm: lost ? null : Math.round(rssi * 10) / 10 });
        ls.push({ anchor_id: a.anchor_id, is_nlos: nlos, bias_m: Math.round(bias * 1000) / 1000, lost });
      }
      readings.push(rs); labels.push(ls);
    });
    return { readings, labels };
  });
}
