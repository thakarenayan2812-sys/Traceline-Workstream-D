// Immutable plan state. All geometry is stored in IMAGE PIXELS (top-left origin, y down);
// conversion to metres happens only in plan_export.js (guide 7: convert back before saving).
import { ZONE_TYPES } from "../core/constants.js";

export function createPlan() {
  return {
    image: null,                                   // {filename, width_px, height_px, sha256|null}
    calibration: { a: null, b: null, known_m: null },
    boundary: null,                                // [{x,y}] walkable floor boundary
    walls: [],                                     // {wall_id, a, b, material}
    obstacles: [],                                 // {obstacle_id, vertices}
    zones: [],                                     // {zone_id, zone_type, name, vertices, shape, density_people_m2}
    next_id: { wall: 1, obstacle: 1, zone: 1 },
  };
}

const pad = (n) => String(n).padStart(3, "0");

/** Pure reducer. Unknown actions throw so typos never pass silently. */
export function reducePlan(plan, action) {
  switch (action.type) {
    case "SET_IMAGE":
      return { ...createPlan(), image: { sha256: null, ...action.image } };
    case "SET_CALIBRATION_POINTS":
      return { ...plan, calibration: { ...plan.calibration, a: action.a, b: action.b } };
    case "SET_KNOWN_DISTANCE":
      return { ...plan, calibration: { ...plan.calibration, known_m: action.known_m } };
    case "SET_BOUNDARY":
      return { ...plan, boundary: action.vertices };
    case "ADD_WALL":
      return { ...plan,
        walls: [...plan.walls, { wall_id: `wall_${pad(plan.next_id.wall)}`, a: action.a, b: action.b, material: action.material ?? "drywall" }],
        next_id: { ...plan.next_id, wall: plan.next_id.wall + 1 } };
    case "ADD_OBSTACLE":
      return { ...plan,
        obstacles: [...plan.obstacles, { obstacle_id: `obstacle_${pad(plan.next_id.obstacle)}`, vertices: action.vertices }],
        next_id: { ...plan.next_id, obstacle: plan.next_id.obstacle + 1 } };
    case "ADD_ZONE": {
      if (!ZONE_TYPES.includes(action.zone_type)) throw new RangeError(`Unknown zone type: ${action.zone_type}`);
      const id = `zone_${pad(plan.next_id.zone)}`;
      return { ...plan,
        zones: [...plan.zones, { zone_id: id, zone_type: action.zone_type, name: action.name || id, vertices: action.vertices,
          shape: action.shape ?? "polygon", density_people_m2: action.density_people_m2 ?? null }],
        next_id: { ...plan.next_id, zone: plan.next_id.zone + 1 } };
    }
    case "DELETE_ITEM": {
      const { kind, id } = action;
      if (kind === "boundary") return { ...plan, boundary: null };
      if (kind === "wall") return { ...plan, walls: plan.walls.filter((w) => w.wall_id !== id) };
      if (kind === "obstacle") return { ...plan, obstacles: plan.obstacles.filter((o) => o.obstacle_id !== id) };
      if (kind === "zone") return { ...plan, zones: plan.zones.filter((z) => z.zone_id !== id) };
      throw new RangeError(`Unknown item kind: ${kind}`);
    }
    case "RESET":   // clears calibration and tracing, keeps the image
      return { ...createPlan(), image: plan.image };
    case "LOAD_GEOMETRY":
      return { ...plan, ...action.geometry };
    default:
      throw new RangeError(`Unknown action: ${action.type}`);
  }
}

// ---- undo / redo (whole-state snapshots; plans are small)
export const createHistory = (present) => ({ past: [], present, future: [] });
export const commit = (h, next, limit = 200) => ({ past: [...h.past, h.present].slice(-limit), present: next, future: [] });
export const undo = (h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past.at(-1), future: [h.present, ...h.future] } : h);
export const redo = (h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h);
