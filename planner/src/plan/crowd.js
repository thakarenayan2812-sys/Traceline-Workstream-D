// Crowd-aware planning model (guide 4 feature 3 and 8, 15). Bodies absorb and block radio, so in a crowd
// zone an anchor reaches less far and a position needs more spare anchors. This file turns drawn crowd
// zones (people per m2, 0 to 4) into two hooks for the D4 coverage problem:
//   * pair_range_factor(anchor, cell): the usable range shrinks with the MEAN density along the path.
//   * required_per_cell(cell): the number of usable anchors needed grows with density AT the cell.
// Both are monotonic and use the coefficients in a crowd model object that is written into every report.
// These coefficients are D's PLANNING assumptions, not the simulator's formula (shared/signal_model.json is
// owned by A and was not available). They must be aligned with it before the team quotes crowd results.
import { pointInPolygon, distance } from "../core/geometry.js";
import { MIN_USABLE_ANCHORS } from "../core/constants.js";

export const MAX_DENSITY_PEOPLE_M2 = 4;   // guide section 7: crowd density range 0 to 4

export const DEFAULT_CROWD_MODEL = Object.freeze({
  range_derate_per_density: 0.1,   // range factor = 1 - 0.1 * density, so 4 people/m2 leaves 60% of the range
  min_range_factor: 0.5,           // the factor never drops below this
  density_per_extra_anchor: 2,     // +1 required anchor above 0, +2 above 2 people/m2 (ceil(density / 2))
  max_extra_anchors: 2,            // cap on the extra requirement
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Validates a (possibly partial) model and returns the full model. Throws RangeError in plain words. */
export function resolveCrowdModel(partial = {}) {
  const m = { ...DEFAULT_CROWD_MODEL, ...partial };
  if (!isNum(m.range_derate_per_density) || m.range_derate_per_density < 0) throw new RangeError("Range loss per person per m2 must be 0 or more.");
  if (!isNum(m.min_range_factor) || m.min_range_factor <= 0 || m.min_range_factor > 1) throw new RangeError("Smallest range factor must be above 0 and at most 1.");
  if (!isNum(m.density_per_extra_anchor) || m.density_per_extra_anchor <= 0) throw new RangeError("Density per extra anchor must be above 0.");
  if (!Number.isInteger(m.max_extra_anchors) || m.max_extra_anchors < 0 || m.max_extra_anchors > 5) throw new RangeError("Maximum extra anchors must be a whole number from 0 to 5.");
  return m;
}

/** Fraction of the assumed range kept when the mean path density is d (monotonic non-increasing). */
export const rangeFactor = (model, d) => Math.max(model.min_range_factor, 1 - model.range_derate_per_density * Math.max(0, d));

/** Extra usable anchors demanded at a cell of density d (monotonic non-decreasing, 0 when d is 0). */
export const extraAnchors = (model, d) => (d > 0 ? Math.min(model.max_extra_anchors, Math.ceil(d / model.density_per_extra_anchor - 1e-12)) : 0);

/**
 * Crowd zones of a venue (contract 9.1) with their density. Density comes from
 * metadata.zone_density_people_m2 (written by toVenue). A crowd zone with no density needs `fallback_density`;
 * there is no built-in default, because the density is an assumption the user must own.
 */
export function crowdZonesFromVenue(venue, { fallback_density = null } = {}) {
  const drawn = venue.metadata?.zone_density_people_m2 ?? {};
  const out = [];
  for (const z of venue.zones ?? []) {
    if (z.zone_type !== "crowd") continue;
    let d = drawn[z.zone_id], source = "drawn";
    if (d == null) { d = fallback_density; source = "fallback"; }
    if (d == null) throw new RangeError(`Crowd zone ${z.zone_id}${z.name ? ` (${z.name})` : ""} has no density. Enter a density for it, or give a density to use for zones without one.`);
    if (!isNum(d) || d < 0 || d > MAX_DENSITY_PEOPLE_M2) throw new RangeError(`Crowd density must be between 0 and ${MAX_DENSITY_PEOPLE_M2} people per m2 (zone ${z.zone_id} has ${d}).`);
    out.push({ zone_id: z.zone_id, name: z.name ?? "", polygon: z.polygon, density_people_m2: d, density_source: source });
  }
  return out;
}

/** The same venue with every crowd zone (and its density) removed: the "without crowd zones" plan. */
export function stripCrowdZones(venue) {
  const crowdIds = new Set((venue.zones ?? []).filter((z) => z.zone_type === "crowd").map((z) => z.zone_id));
  const { zone_density_people_m2: _drop, ...meta } = venue.metadata ?? {};
  return { ...venue, zones: (venue.zones ?? []).filter((z) => !crowdIds.has(z.zone_id)), metadata: meta };
}

/**
 * Density raster over the venue. Cell (i, j) holds the highest density of any crowd zone containing its
 * centre (touching the edge counts as inside). at(x, y) is 0 outside the venue.
 */
export function buildCrowdField(venue, zones, resolution_m) {
  if (!isNum(resolution_m) || resolution_m <= 0) throw new RangeError("Grid resolution must be a positive number of metres.");
  const nx = Math.ceil(venue.width_m / resolution_m), ny = Math.ceil(venue.height_m / resolution_m);
  const dens = new Float32Array(nx * ny);
  for (const z of zones) {
    if (!(z.density_people_m2 > 0)) continue;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (dens[idx] >= z.density_people_m2) continue;
      if (pointInPolygon({ x: (i + 0.5) * resolution_m, y: (j + 0.5) * resolution_m }, z.polygon) !== "outside") dens[idx] = z.density_people_m2;
    }
  }
  const at = (x, y) => {
    const i = Math.floor(x / resolution_m), j = Math.floor(y / resolution_m);
    return i < 0 || j < 0 || i >= nx || j >= ny ? 0 : dens[j * nx + i];
  };
  /** Mean density along the straight path a -> b, sampled about once per cell, both ends included. */
  const pathMean = (a, b) => {
    const n = Math.max(1, Math.ceil(distance(a, b) / resolution_m));
    let s = 0;
    for (let k = 0; k <= n; k++) { const t = k / n; s += at(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); }
    return s / (n + 1);
  };
  return { resolution_m, nx, ny, zones, at, pathMean, anyCrowd: dens.some((v) => v > 0) };
}

/** Options to merge into buildCoverageProblem so that the problem becomes crowd-aware. */
export function crowdOptions(field, model, base = MIN_USABLE_ANCHORS) {
  return {
    required_per_cell: (c) => base + extraAnchors(model, field.at(c.x, c.y)),
    pair_range_factor: (a, c) => rangeFactor(model, field.pathMean(a, c)),
  };
}

/** Plain-words statement of the model for reports and the page. */
export function describeCrowdModel(model) {
  return [
    `Usable range along a path = assumed range x max(${model.min_range_factor}, 1 - ${model.range_derate_per_density} x mean density on the path), where density is in people per m2.`,
    `Usable anchors needed at a cell = base requirement + min(${model.max_extra_anchors}, ceil(density at the cell / ${model.density_per_extra_anchor})), and no extra where density is 0.`,
    "Where crowd zones overlap, the higher density applies.",
    "These coefficients are planning assumptions chosen by the planner author. They are not measured and not yet aligned with the simulator's crowd formula.",
  ];
}
