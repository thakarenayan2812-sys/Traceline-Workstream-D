// Plan validation (guide 9.4). Errors block export; warnings are recorded in plan.json.
// If scale or geometry cannot be established we say so; we never invent metres from pixels.
import { polygonIsSimple, polygonArea, distance } from "../core/geometry.js";

export const MAX_DENSITY = 4;   // people per m^2, guide section 7

export const toPairs = (verts) => verts.map((p) => [p.x, p.y]);

/** Metres per image pixel from the calibration, or null when it cannot be established. */
export function metresPerPixel(cal) {
  if (!cal?.a || !cal?.b || !Number.isFinite(cal.known_m) || cal.known_m <= 0) return null;
  const d = distance(cal.a, cal.b);
  return d > 0 ? cal.known_m / d : null;
}

/** Bounding box (image px) of every traced vertex: boundary, walls, obstacles, zones. */
export function tracedBounds(plan) {
  const pts = [
    ...(plan.boundary ?? []),
    ...plan.walls.flatMap((w) => [w.a, w.b]),
    ...plan.obstacles.flatMap((o) => o.vertices),
    ...plan.zones.flatMap((z) => z.vertices),
  ];
  if (!pts.length) return null;
  return {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
  };
}

/** @returns {{errors:string[], warnings:string[], metres_per_px:number|null, width_m:number|null, height_m:number|null}} */
export function validatePlan(plan) {
  const errors = [], warnings = [];
  if (!plan.image) errors.push("Upload a floor-plan image first.");

  const c = plan.calibration;
  const mpp = metresPerPixel(c);
  if (!c.a || !c.b) errors.push("Mark two points a known distance apart to set the scale.");
  else if (distance(c.a, c.b) <= 0) errors.push("The two scale points are identical. Mark two different points.");
  if (!(Number.isFinite(c.known_m) && c.known_m > 0)) errors.push("Enter the real distance between the two scale points, in metres.");

  if (!plan.boundary) errors.push("Trace the walkable floor boundary.");
  else if (plan.boundary.length < 3) errors.push("The floor boundary needs at least 3 points.");
  else if (!polygonIsSimple(toPairs(plan.boundary))) errors.push("The floor boundary crosses itself or repeats a point. Delete it and trace it again.");
  else if (polygonArea(toPairs(plan.boundary)) <= 0) errors.push("The floor boundary has no area.");

  for (const o of plan.obstacles)
    if (!polygonIsSimple(toPairs(o.vertices))) errors.push(`${o.obstacle_id} crosses itself or has fewer than 3 points. Delete and redraw it.`);
  for (const z of plan.zones) {
    if (!polygonIsSimple(toPairs(z.vertices))) errors.push(`${z.zone_id} crosses itself or has fewer than 3 points. Delete and redraw it.`);
    const d = z.density_people_m2;
    if (d != null && !(Number.isFinite(d) && d >= 0 && d <= MAX_DENSITY)) errors.push(`${z.zone_id}: crowd density must be between 0 and ${MAX_DENSITY} people per square metre.`);
  }
  for (const w of plan.walls) if (distance(w.a, w.b) <= 0) errors.push(`${w.wall_id} has zero length. Delete it.`);

  let width_m = null, height_m = null;
  const b = tracedBounds(plan);
  if (mpp && b) {
    width_m = (b.maxX - b.minX) * mpp;
    height_m = (b.maxY - b.minY) * mpp;
    if (width_m < 2 || height_m < 2 || width_m > 500 || height_m > 500)
      warnings.push(`The traced area is ${width_m.toFixed(1)} x ${height_m.toFixed(1)} m. Check the scale distance; that size is unusual for a building floor.`);
  }
  if (mpp && c.a && c.b) {
    const d = distance(c.a, c.b);
    const relErr = 1 / d;
    if (relErr > 0.02) warnings.push(`The scale points are only ${d.toFixed(0)} px apart, so one pixel of clicking error shifts every distance by about ${(relErr * 100).toFixed(1)}%. Use a longer known distance.`);
    if (plan.image && d < 0.1 * Math.max(plan.image.width_px, plan.image.height_px))
      warnings.push("The scale distance covers less than 10% of the image. A longer baseline gives a more reliable scale.");
    if (1 / mpp < 5) warnings.push(`The image has about ${(1 / mpp).toFixed(1)} px per metre. Tracing precision is limited; use a higher-resolution image if you can.`);
  }
  if (plan.walls.length === 0 && plan.boundary)
    warnings.push("No walls are traced. Every path will count as clear line of sight, so coverage will look better than it is.");

  return { errors, warnings, metres_per_px: mpp, width_m, height_m };
}
