// Deterministic 2D geometry in metres (guide section 8: "touching endpoints and
// near-parallel segments" must be tested). Pure functions, no hidden state.
//
// POLICIES (also recorded in DECISIONS.md):
//  P1  Tolerance: contacts closer than TOL_M (1 micrometre) count as touching.
//  P2  Parallel: segments whose sine of angle is below 1e-9 are treated as parallel;
//      they intersect only if within TOL_M of each other (collinear).
//  P3  Line of sight (LOS): contact exactly at the LOS segment's own endpoint
//      (an anchor mounted on a wall, a target standing at a wall) does NOT block.
//  P4  LOS touching a wall or polygon vertex anywhere else DOES block (conservative).
//  P5  LOS running along a wall or polygon edge (collinear overlap) blocks.
//  P6  Obstacles are solid: LOS is blocked if either endpoint or the midpoint lies
//      strictly inside the polygon, or if any edge blocks it.

export const TOL_M = 1e-6;
const PARALLEL_SIN = 1e-9;
const NONE = Object.freeze({ kind: "none" });

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** Shortest distance from point p to segment a-b. */
export function distancePointSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  if (l2 === 0) return distance(p, a);
  const t = clamp01(dot(sub(p, a), ab) / l2);
  return distance(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
}

/**
 * Intersection of segments p1-p2 and q1-q2.
 * @returns {{kind:"none"}|{kind:"point",point:{x:number,y:number}}|{kind:"overlap",from:object,to:object}}
 */
export function segmentIntersection(p1, p2, q1, q2, tol = TOL_M) {
  const r = sub(p2, p1), s = sub(q2, q1);
  const lr = len(r), ls = len(s);
  if (lr <= tol && ls <= tol) return distance(p1, q1) <= tol ? { kind: "point", point: { ...p1 } } : NONE;
  if (lr <= tol) return distancePointSegment(p1, q1, q2) <= tol ? { kind: "point", point: { ...p1 } } : NONE;
  if (ls <= tol) return distancePointSegment(q1, p1, p2) <= tol ? { kind: "point", point: { ...q1 } } : NONE;

  const denom = cross(r, s);
  const qp = sub(q1, p1);
  if (Math.abs(denom) <= PARALLEL_SIN * lr * ls) {
    // Parallel: must be on the same line (within tol) to touch at all.
    if (Math.abs(cross(qp, r)) / lr > tol || Math.abs(cross(sub(q2, p1), r)) / lr > tol) return NONE;
    const t0 = dot(qp, r) / (lr * lr), t1 = dot(sub(q2, p1), r) / (lr * lr);
    const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
    const tolT = tol / lr;
    if (lo > hi + tolT) return NONE;
    const at = (t) => ({ x: p1.x + r.x * t, y: p1.y + r.y * t });
    if (hi - lo <= tolT) return { kind: "point", point: at(clamp01((lo + hi) / 2)) };
    return { kind: "overlap", from: at(lo), to: at(hi) };
  }
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  const tolT = tol / lr, tolU = tol / ls;
  if (t < -tolT || t > 1 + tolT || u < -tolU || u > 1 + tolU) return NONE;
  const tc = clamp01(t);
  return { kind: "point", point: { x: p1.x + r.x * tc, y: p1.y + r.y * tc } };
}

/** Does the line-of-sight segment a-t get blocked by the edge e1-e2? (policies P3 to P5) */
export function segmentBlockedByEdge(a, t, e1, e2, tol = TOL_M) {
  const hit = segmentIntersection(a, t, e1, e2, tol);
  if (hit.kind === "none") return false;
  if (hit.kind === "point") return !(distance(hit.point, a) <= tol || distance(hit.point, t) <= tol);
  return true; // overlap along the edge
}

/**
 * Point in polygon. polygon is [[x,y],...] (not repeated at the end).
 * @returns {"inside"|"boundary"|"outside"}
 */
export function pointInPolygon(pt, polygon, tol = TOL_M) {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % n];
    if (distancePointSegment(pt, { x: ax, y: ay }, { x: bx, y: by }) <= tol) return "boundary";
  }
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? "inside" : "outside";
}

/** Signed area: positive for counter-clockwise vertex order. */
export function polygonSignedArea(polygon) {
  let s = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}
export const polygonArea = (polygon) => Math.abs(polygonSignedArea(polygon));

/** LOS vs one solid polygon (policy P6). */
export function segmentBlockedByPolygon(a, t, polygon, tol = TOL_M) {
  const mid = { x: (a.x + t.x) / 2, y: (a.y + t.y) / 2 };
  if (pointInPolygon(a, polygon, tol) === "inside" || pointInPolygon(t, polygon, tol) === "inside" ||
      pointInPolygon(mid, polygon, tol) === "inside") return true;
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = polygon[i], [bx, by] = polygon[(i + 1) % n];
    if (segmentBlockedByEdge(a, t, { x: ax, y: ay }, { x: bx, y: by }, tol)) return true;
  }
  return false;
}

/**
 * Line of sight between anchor a and target t against venue walls and obstacles.
 * @param {{walls?:object[], obstacles?:object[]}} geom venue-contract shaped (guide 9.1)
 * @returns {{blocked:boolean, blockers:string[]}} ids of every wall/obstacle that blocks
 */
export function lineOfSight(a, t, geom, tol = TOL_M) {
  const blockers = [];
  const minX = Math.min(a.x, t.x) - tol, maxX = Math.max(a.x, t.x) + tol;
  const minY = Math.min(a.y, t.y) - tol, maxY = Math.max(a.y, t.y) + tol;
  for (const w of geom.walls ?? []) {
    if (Math.max(w.x1_m, w.x2_m) < minX || Math.min(w.x1_m, w.x2_m) > maxX ||
        Math.max(w.y1_m, w.y2_m) < minY || Math.min(w.y1_m, w.y2_m) > maxY) continue;
    if (segmentBlockedByEdge(a, t, { x: w.x1_m, y: w.y1_m }, { x: w.x2_m, y: w.y2_m }, tol)) blockers.push(w.wall_id);
  }
  for (const o of geom.obstacles ?? []) {
    if (segmentBlockedByPolygon(a, t, o.vertices, tol)) blockers.push(o.obstacle_id);
  }
  return { blocked: blockers.length > 0, blockers };
}

/**
 * Metric grid over the venue. Cell (i, j) covers [i*res, (i+1)*res) x [j*res, (j+1)*res);
 * its centre is ((i+0.5)*res, (j+0.5)*res). A cell is walkable when its centre is inside the
 * venue, inside the optional boundary polygon (edge counts as inside), and not strictly
 * inside an obstacle. Results are approximations at this resolution.
 */
export function buildGrid(venue, resolution_m, { boundary = null, obstacles = [], maxCells = 2_000_000 } = {}) {
  if (!Number.isFinite(resolution_m) || resolution_m <= 0) throw new RangeError("Grid resolution must be a positive number of metres.");
  const nx = Math.ceil(venue.width_m / resolution_m), ny = Math.ceil(venue.height_m / resolution_m);
  if (nx * ny > maxCells) {
    throw new RangeError(`Grid would have ${nx * ny} cells (limit ${maxCells}). Use a coarser resolution.`);
  }
  const cellCenter = (i, j) => ({ x: (i + 0.5) * resolution_m, y: (j + 0.5) * resolution_m });
  const walkable = new Uint8Array(nx * ny);
  let walkableCount = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = cellCenter(i, j);
      if (c.x > venue.width_m || c.y > venue.height_m) continue;
      if (boundary && pointInPolygon(c, boundary) === "outside") continue;
      if (obstacles.some((o) => pointInPolygon(c, o.vertices) === "inside")) continue;
      walkable[j * nx + i] = 1;
      walkableCount++;
    }
  }
  return { nx, ny, resolution_m, walkable, walkableCount, cellCenter, index: (i, j) => j * nx + i,
    walkableAreaM2: walkableCount * resolution_m * resolution_m };
}

/**
 * Which walkable cells can this anchor serve: within maxRange_m and with clear line of sight.
 * @returns {Uint8Array} one flag per grid cell (0 for non-walkable cells)
 */
export function computeVisibility(anchor, grid, geom, maxRange_m) {
  if (!Number.isFinite(maxRange_m) || maxRange_m <= 0) throw new RangeError("Maximum range must be a positive number of metres.");
  const out = new Uint8Array(grid.nx * grid.ny);
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const idx = j * grid.nx + i;
      if (!grid.walkable[idx]) continue;
      const c = grid.cellCenter(i, j);
      if (distance(anchor, c) > maxRange_m) continue;
      if (!lineOfSight(anchor, c, geom).blocked) out[idx] = 1;
    }
  }
  return out;
}

/**
 * True when the polygon has at least 3 vertices, no repeated consecutive vertices,
 * no edge crossing or touching a non-adjacent edge, and no edge doubling back on its neighbour.
 */
export function polygonIsSimple(polygon, tol = TOL_M) {
  const n = polygon.length;
  if (n < 3) return false;
  const V = polygon.map(([x, y]) => ({ x, y }));
  const edge = (i) => [V[i], V[(i + 1) % n]];
  for (let i = 0; i < n; i++) if (distance(V[i], V[(i + 1) % n]) <= tol) return false;
  for (let i = 0; i < n; i++) {
    const [a, b] = edge(i);
    const [c, d] = edge((i + 1) % n);
    if (segmentIntersection(a, b, c, d, tol).kind === "overlap") return false;   // doubles back
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;                                      // adjacent via wrap
      const [e, f] = edge(j);
      if (segmentIntersection(a, b, e, f, tol).kind !== "none") return false;
    }
  }
  return true;
}
