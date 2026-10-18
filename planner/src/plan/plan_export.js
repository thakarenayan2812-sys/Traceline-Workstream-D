// Plan -> plan.json sidecar (guide 9.4) and venue.json (guide 9.1). Conversion image px -> metres
// happens here and only here. Origin = bottom-left of the bounding box of ALL traced geometry.
import { CONTRACT_VERSION, MIN_USABLE_ANCHORS } from "../core/constants.js";
import { imagePxToMetres, metresToImagePx } from "../core/transforms.js";
import { validatePlan, tracedBounds } from "./plan_validate.js";
import { createPlan } from "./plan_model.js";

export const PLAN_SCHEMA_VERSION = "1.0";
const r3 = (v) => Math.round(v * 1000) / 1000;   // positions: 3 decimals (guide 7)

export class PlanValidationError extends Error {
  constructor(errors) { super("The plan has problems: " + errors.join(" ")); this.errors = errors; }
}

/**
 * Build the plan.json sidecar. Throws PlanValidationError when the plan cannot be exported.
 * `created_at` is injected so tests and re-exports are deterministic.
 */
export function buildPlanJson(plan, { created_at = new Date().toISOString(), settings = {} } = {}) {
  const v = validatePlan(plan);
  if (v.errors.length) throw new PlanValidationError(v.errors);
  const mpp = v.metres_per_px;
  const b = tracedBounds(plan);
  const origin_px = { x: b.minX, y: b.maxY };
  const toM = (p) => { const m = imagePxToMetres(p, origin_px, mpp); return [r3(m.x), r3(m.y)]; };
  const px = (p) => ({ x: p.x, y: p.y });
  return {
    schema_version: PLAN_SCHEMA_VERSION,
    contract_version: CONTRACT_VERSION,
    plan_kind: "blueprint_plan",
    created_at,
    source_image: { ...plan.image },
    scale: {
      point_a_px: px(plan.calibration.a), point_b_px: px(plan.calibration.b),
      known_distance_m: plan.calibration.known_m, metres_per_px: mpp, px_per_m: 1 / mpp,
    },
    transform: {
      origin_px, y_axis: "up", width_m: r3(v.width_m), height_m: r3(v.height_m),
      description: "Metres, origin at the bottom-left of the bounding box of all traced geometry, x right, y up. Image pixels have a top-left origin with y down.",
    },
    geometry: {
      boundary_m: plan.boundary.map(toM),
      walls_m: plan.walls.map((w) => ({ wall_id: w.wall_id, a: toM(w.a), b: toM(w.b), material: w.material })),
      obstacles_m: plan.obstacles.map((o) => ({ obstacle_id: o.obstacle_id, vertices: o.vertices.map(toM) })),
      zones_m: plan.zones.map((z) => ({ zone_id: z.zone_id, zone_type: z.zone_type, name: z.name, polygon: z.vertices.map(toM),
        shape: z.shape, density_people_m2: z.density_people_m2 })),
    },
    geometry_px: {
      boundary: plan.boundary.map(px),
      walls: plan.walls.map((w) => ({ ...w, a: px(w.a), b: px(w.b) })),
      obstacles: plan.obstacles.map((o) => ({ ...o, vertices: o.vertices.map(px) })),
      zones: plan.zones.map((z) => ({ ...z, vertices: z.vertices.map(px) })),
    },
    planner_settings: {
      required_usable_anchors: MIN_USABLE_ANCHORS,
      max_range_m: null, grid_resolution_m: null, search_budget: null, mounting_constraints: null,
      ...settings,
    },
    validation: { errors: [], warnings: v.warnings },
    notes: [
      "Geometry was traced by hand by the user. No automatic architectural understanding was performed.",
      "Scale comes from one user-marked distance; its accuracy limits every distance derived from it.",
      "Walls are treated as fully blocking in version 1; the material label is recorded only.",
      "Processed locally in the browser. The image was not uploaded anywhere.",
    ],
  };
}

/** Venue contract (guide 9.1) from a plan. Anchors start empty; the planner fills them in D4 to D6. */
export function toVenue(plan, opts) {
  const p = buildPlanJson(plan, opts);
  const g = p.geometry;
  return {
    schema_version: "1.0",
    venue_id: "custom",
    width_m: p.transform.width_m,
    height_m: p.transform.height_m,
    anchors: [],
    walls: g.walls_m.map((w) => ({ wall_id: w.wall_id, x1_m: w.a[0], y1_m: w.a[1], x2_m: w.b[0], y2_m: w.b[1], material: w.material })),
    obstacles: g.obstacles_m.map((o) => ({ obstacle_id: o.obstacle_id, vertices: o.vertices })),
    zones: g.zones_m.map((z) => ({ zone_id: z.zone_id, zone_type: z.zone_type, polygon: z.polygon, name: z.name })),
    metadata: {
      source: "blueprint_plan",
      walkable_boundary_m: g.boundary_m,
      scale_metres_per_px: p.scale.metres_per_px,
      zone_density_people_m2: Object.fromEntries(g.zones_m.filter((z) => z.zone_type === "crowd" && z.density_people_m2 != null).map((z) => [z.zone_id, z.density_people_m2])),
      warnings: p.validation.warnings,
      note: "Boundary is stored here because contract 9.1 has no top-level walkable-area key. Custom venue, not part of any dataset.",
    },
  };
}

/** Rebuild an editable plan from a plan.json (image must be supplied again by the user). */
export function planFromJson(obj) {
  if (!obj || obj.plan_kind !== "blueprint_plan") throw new Error("This file is not a Traceline plan.json.");
  if (obj.schema_version !== PLAN_SCHEMA_VERSION) throw new Error(`Unsupported plan version ${obj.schema_version}. Expected ${PLAN_SCHEMA_VERSION}.`);
  const gp = obj.geometry_px, s = obj.scale;
  if (!gp || !s) throw new Error("The plan.json is missing its traced geometry or scale.");
  const plan = createPlan();
  const ids = (arr, key) => Math.max(0, ...arr.map((i) => Number(String(i[key]).split("_").pop()) || 0)) + 1;
  return {
    ...plan,
    image: { sha256: null, ...obj.source_image },
    calibration: { a: s.point_a_px, b: s.point_b_px, known_m: s.known_distance_m },
    boundary: gp.boundary, walls: gp.walls, obstacles: gp.obstacles, zones: gp.zones,
    next_id: { wall: ids(gp.walls, "wall_id"), obstacle: ids(gp.obstacles, "obstacle_id"), zone: ids(gp.zones, "zone_id") },
  };
}

/** Circle as a polygon (n vertices, counter-clockwise in image-up terms). Used by the crowd-circle tool. */
export function circlePolygon(center, radius_px, n = 32) {
  return Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n;
    return { x: center.x + radius_px * Math.cos(t), y: center.y - radius_px * Math.sin(t) };
  });
}

export { metresToImagePx };
