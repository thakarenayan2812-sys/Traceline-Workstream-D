// Layered map drawing (guide 15 D7). Order: walkable area, zones, obstacles, walls, anchors, trail, truth,
// uncertainty, estimate, forecast. Each layer has its own shape or line style, so colour is never the only cue.
// Pure drawing: the caller supplies the context, the colours and the state. Metres in, pixels out (guide 7).
import { fitView, metresToPixels } from "../../../planner/src/core/transforms.js";

const TRAIL = 20;

/**
 * @param g 2D context (already sized and scaled for devicePixelRatio)
 * @param p {w, h, venue, anchors (active), index, outputs, scenarioTruth, colors, reduceMotion, emergency, flagged}
 * @returns {{view}} the view used, so the caller can map pointer positions if needed
 */
export function drawMap(g, p) {
  const { w, h, venue, colors: C } = p;
  const view = fitView(venue, w, h, 20);
  const P = (x, y) => metresToPixels({ x, y }, view);
  const poly = (pts, fill, stroke, dash = []) => {
    g.beginPath();
    pts.forEach(([x, y], i) => { const q = P(x, y); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y); });
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.25; g.setLineDash(dash); g.stroke(); g.setLineDash([]); }
  };
  g.clearRect(0, 0, w, h);

  // 1. walkable area
  const boundary = venue.metadata?.walkable_boundary_m;
  poly(boundary ?? [[0, 0], [venue.width_m, 0], [venue.width_m, venue.height_m], [0, venue.height_m]], C.walkable, C.line);

  // 2. zones: crowd (dotted outline, warm fill) and restricted (dashed outline, grey fill)
  for (const z of venue.zones ?? []) {
    const crowd = z.zone_type === "crowd";
    poly(z.polygon, crowd ? C.crowd : C.restricted, crowd ? C.warn : C.muted, crowd ? [2, 3] : [6, 4]);
    const c = P(...centroid(z.polygon));
    g.fillStyle = C.ink; g.font = "12px system-ui"; g.textAlign = "center";
    g.fillText(z.name ?? z.zone_id, c.x, c.y);
  }

  // 3. obstacles and walls
  for (const o of venue.obstacles ?? []) poly(o.vertices, C.restricted, C.muted);
  g.strokeStyle = C.ink; g.lineWidth = 3; g.lineCap = "round";
  for (const wl of venue.walls ?? []) { const a = P(wl.x1_m, wl.y1_m), b = P(wl.x2_m, wl.y2_m); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }

  // 4. anchors: filled squares when active, with a warning ring and an "obstructed?" tag for suspected NLOS
  const cur = p.outputs[p.index];
  const suspects = new Set(cur?.suspected_nlos ?? []);
  g.textAlign = "left";
  for (const a of venue.anchors) {
    const active = p.anchors.some((x) => x.anchor_id === a.anchor_id);
    const q = P(a.x_m, a.y_m);
    if (active) { g.fillStyle = C.ink; g.fillRect(q.x - 5, q.y - 5, 10, 10); }
    else { g.strokeStyle = C.muted; g.setLineDash([2, 2]); g.strokeRect(q.x - 5, q.y - 5, 10, 10); g.setLineDash([]); }
    g.fillStyle = active ? C.ink : C.muted; g.font = "12px system-ui";
    const label = `${a.anchor_id}${active ? "" : " (off)"}${suspects.has(a.anchor_id) ? " obstructed?" : ""}`;
    const lw = g.measureText(label).width;
    const lx = q.x + 8 + lw > w - 4 ? q.x - 8 - lw : q.x + 8; // flip inside the canvas near the right edge
    g.fillText(label, lx, q.y - 6);
    if (suspects.has(a.anchor_id)) { g.strokeStyle = C.warn; g.lineWidth = 2; g.beginPath(); g.arc(q.x, q.y, 11, 0, 7); g.stroke(); }
  }

  // 5. trail: last TRAIL estimates up to the current step (fades unless reduced motion is requested)
  const from = Math.max(0, p.index - TRAIL + 1);
  for (let i = from + 1; i <= p.index; i++) {
    const a = p.outputs[i - 1].estimate, b = p.outputs[i].estimate;
    const A = P(a.x_m, a.y_m), B = P(b.x_m, b.y_m);
    g.strokeStyle = C.accent; g.lineWidth = 2;
    g.globalAlpha = p.reduceMotion ? 0.6 : 0.15 + 0.6 * ((i - from) / (p.index - from));
    g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke();
  }
  g.globalAlpha = 1;

  // 6. truth: open ring (replay only)
  if (cur) { const t = P(cur.truth.x_m ?? cur.truth.x, cur.truth.y_m ?? cur.truth.y); g.strokeStyle = C.ink; g.lineWidth = 2; g.setLineDash([]); g.beginPath(); g.arc(t.x, t.y, 8, 0, 7); g.stroke(); }

  if (!cur) return { view };
  // 7. uncertainty: dashed circle of radius sigma (1 sigma, uncalibrated in the mock)
  const e = P(cur.estimate.x_m, cur.estimate.y_m);
  const edge = cur.out_of_bounds;
  const drawAt = edge ? clampToCanvas(e, w, h) : e;
  g.strokeStyle = cur.sigma_m > 1.0 || p.emergency ? C.warn : C.muted; g.lineWidth = 1.5; g.setLineDash([5, 4]);
  g.beginPath(); g.arc(e.x, e.y, Math.max(2, cur.sigma_m * view.px_per_m), 0, 7); g.stroke(); g.setLineDash([]);

  // 8. forecast: hollow dotted circles at +0.5 s .. +2 s
  g.strokeStyle = C.accent; g.setLineDash([2, 3]); g.lineWidth = 1.5; g.fillStyle = C.ink; g.font = "11px system-ui";
  cur.predicted.forEach((f, i) => {
    const q = P(f.x_m, f.y_m);
    g.beginPath(); g.arc(q.x, q.y, 4, 0, 7); g.stroke();
    g.fillText(`+${(i + 1) * 0.5}s`, q.x + 6, q.y + 3);
  });
  g.setLineDash([]);

  // 9. estimate: filled dot (or edge arrow with label when the raw estimate is outside the venue)
  g.fillStyle = C.accent; g.beginPath(); g.arc(drawAt.x, drawAt.y, 5.5, 0, 7); g.fill();
  if (edge) { g.fillStyle = C.warn; g.font = "bold 12px system-ui"; g.fillText("estimate outside venue", Math.min(drawAt.x + 8, w - 170), drawAt.y - 8); }

  // emergency frame: thick warning border so the mode is visible without colour
  if (p.emergency) { g.strokeStyle = C.warn; g.lineWidth = 4; g.strokeRect(2, 2, w - 4, h - 4); }
  return { view };
}

function centroid(poly) {
  const n = poly.length;
  return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
}
function clampToCanvas(q, w, h) { return { x: Math.min(w - 8, Math.max(8, q.x)), y: Math.min(h - 8, Math.max(8, q.y)) }; }
