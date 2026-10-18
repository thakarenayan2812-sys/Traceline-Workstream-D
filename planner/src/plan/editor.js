// Editor state machine: tools, drafting, commit, undo/redo. The browser page only forwards events
// here, so every behaviour is testable in Node. Points are IMAGE pixels.
import { ZONE_TYPES } from "../core/constants.js";
import { distance } from "../core/geometry.js";
import { createPlan, reducePlan, createHistory, commit, undo, redo } from "./plan_model.js";
import { circlePolygon } from "./plan_export.js";

export const TOOLS = Object.freeze(["calibrate", "boundary", "wall", "obstacle", "zone", "crowd_circle"]);
export const TOOL_LABELS = Object.freeze({
  calibrate: "Set scale", boundary: "Floor boundary", wall: "Walls", obstacle: "Obstacles", zone: "Zones", crowd_circle: "Crowd circle",
});
const POLYGON_TOOLS = new Set(["boundary", "obstacle", "zone"]);
const MIN_POINT_GAP_PX = 2;

export function createEditor() {
  let hist = createHistory(createPlan());
  let tool = "calibrate";
  let draft = [];
  let message = "Choose a PNG or JPEG floor plan to begin.";
  const options = { wall_material: "drywall", zone_type: "crowd", zone_name: "", density_people_m2: null, chain_walls: true };

  const plan = () => hist.present;
  const apply = (action) => { hist = commit(hist, reducePlan(plan(), action)); };
  const say = (m) => { message = m; return { ok: false, message: m }; };
  const ok = (m) => { message = m; return { ok: true, message: m }; };
  const inImage = (p) => plan().image && p.x >= 0 && p.y >= 0 && p.x <= plan().image.width_px && p.y <= plan().image.height_px;

  function hint() {
    if (!plan().image) return "Choose a PNG or JPEG floor plan to begin.";
    const n = draft.length;
    switch (tool) {
      case "calibrate": return "Click two points a known distance apart (for example a scale bar), then enter that distance in metres.";
      case "boundary": return n < 3 ? `Click the corners of the walkable floor. ${n} placed; need at least 3.` : `${n} corners placed. Finish the shape when the outline is complete.`;
      case "wall": return n === 0 ? "Click the start of a wall." : "Click the end of the wall.";
      case "obstacle": return n < 3 ? `Click the corners of the obstacle. ${n} placed; need at least 3.` : `${n} corners placed. Finish the shape when done.`;
      case "zone": return n < 3 ? `Click the corners of the zone. ${n} placed; need at least 3.` : `${n} corners placed. Finish the shape when done.`;
      case "crowd_circle": return n === 0 ? "Click the centre of the crowd area." : "Click a point on the edge of the crowd area.";
      default: return "";
    }
  }

  function commitPolygon() {
    const verts = draft;
    if (tool === "boundary") apply({ type: "SET_BOUNDARY", vertices: verts });
    else if (tool === "obstacle") apply({ type: "ADD_OBSTACLE", vertices: verts });
    else apply({ type: "ADD_ZONE", zone_type: options.zone_type, name: options.zone_name.trim(), vertices: verts,
      density_people_m2: options.zone_type === "crowd" ? options.density_people_m2 : null });
    draft = [];
  }

  return {
    snapshot: () => ({ plan: plan(), draft, tool, message: message || hint(), hint: hint(), canUndo: hist.past.length > 0, canRedo: hist.future.length > 0, options: { ...options } }),

    setImage(meta) { hist = createHistory(reducePlan(createPlan(), { type: "SET_IMAGE", image: meta })); draft = []; tool = "calibrate"; return ok(hint()); },
    setTool(t) { if (!TOOLS.includes(t)) throw new RangeError(`Unknown tool: ${t}`); tool = t; draft = []; message = ""; },
    setOption(k, v) {
      if (!(k in options)) throw new RangeError(`Unknown option: ${k}`);
      if (k === "zone_type" && !ZONE_TYPES.includes(v)) throw new RangeError(`Unknown zone type: ${v}`);
      options[k] = v;
    },
    setKnownDistance(m) { apply({ type: "SET_KNOWN_DISTANCE", known_m: Number.isFinite(m) && m > 0 ? m : null }); message = ""; },

    click(pt) {
      if (!plan().image) return say("Choose an image first.");
      if (!inImage(pt)) return say("That point is outside the image.");
      if (tool === "calibrate") {
        const c = plan().calibration;
        if (!c.a || (c.a && c.b)) { apply({ type: "SET_CALIBRATION_POINTS", a: pt, b: null }); return ok("First scale point set. Click the second point."); }
        if (distance(c.a, pt) < MIN_POINT_GAP_PX) return say("Pick a second point at least a few pixels from the first.");
        apply({ type: "SET_CALIBRATION_POINTS", a: c.a, b: pt });
        return ok("Scale points set. Enter the real distance between them in metres.");
      }
      if (tool === "wall") {
        if (draft.length === 0) { draft = [pt]; return ok(hint()); }
        if (distance(draft[0], pt) < MIN_POINT_GAP_PX) return say("A wall needs two different points.");
        apply({ type: "ADD_WALL", a: draft[0], b: pt, material: options.wall_material });
        draft = options.chain_walls ? [pt] : [];
        return ok("Wall added.");
      }
      if (tool === "crowd_circle") {
        if (draft.length === 0) { draft = [pt]; return ok(hint()); }
        const r = distance(draft[0], pt);
        if (r < MIN_POINT_GAP_PX) return say("The circle is too small. Click further from the centre.");
        apply({ type: "ADD_ZONE", zone_type: "crowd", name: options.zone_name.trim(), vertices: circlePolygon(draft[0], r),
          shape: "circle", density_people_m2: options.density_people_m2 });
        draft = [];
        return ok("Crowd circle added.");
      }
      if (draft.length && distance(draft.at(-1), pt) < MIN_POINT_GAP_PX) return say("That point is on top of the previous one.");
      draft = [...draft, pt];
      return ok(hint());
    },

    finish() {
      if (!POLYGON_TOOLS.has(tool)) return say("Nothing to finish with this tool.");
      if (draft.length < 3) return say("A shape needs at least 3 points.");
      commitPolygon();
      return ok("Shape added.");
    },
    cancel() { draft = []; return ok("Drawing cancelled."); },
    removeLastDraftPoint() { draft = draft.slice(0, -1); return ok(hint()); },
    deleteItem(kind, id) { apply({ type: "DELETE_ITEM", kind, id }); return ok("Deleted."); },
    undo() { draft = []; hist = undo(hist); return ok("Undone."); },
    redo() { draft = []; hist = redo(hist); return ok("Redone."); },
    reset() { draft = []; apply({ type: "RESET" }); return ok("Scale and tracing cleared. The image is kept."); },
    loadPlan(p) { draft = []; hist = commit(hist, p); return ok("Plan loaded."); },
  };
}
