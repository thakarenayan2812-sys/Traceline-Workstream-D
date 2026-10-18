// Coverage model (guide 9.4, contract v1). A walkable grid cell is COVERED when at least
// `required` anchors are each within the assumed maximum range of the cell centre AND have
// clear line of sight (no traced wall or obstacle in between). Geometric only: this says nothing
// about real radio behaviour. Cells are sampled at their centres at the chosen resolution.
import { MIN_USABLE_ANCHORS, MAX_ANCHOR_SLOTS } from "../core/constants.js";
import { buildGrid, computeVisibility, pointInPolygon, distancePointSegment, distance } from "../core/geometry.js";

export const DEFAULTS = Object.freeze({
  resolution_m: 1, candidate_spacing_m: 2, min_wall_clearance_m: 0.2, max_pairs: 50_000_000,
  mounting: Object.freeze({ mode: "floor_area", exclude_zone_types: [] }),
});

const positive = (name, v) => { if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${name} must be a positive number.`); };
const wallSegs = (venue) => (venue.walls ?? []).map((w) => [{ x: w.x1_m, y: w.y1_m }, { x: w.x2_m, y: w.y2_m }]);

/** Boundary edges of the walkable area (or of the venue rectangle when none is traced). */
function boundaryEdges(venue) {
  const b = venue.metadata?.walkable_boundary_m ?? [[0, 0], [venue.width_m, 0], [venue.width_m, venue.height_m], [0, venue.height_m]];
  return b.map((p, i) => [{ x: p[0], y: p[1] }, { x: b[(i + 1) % b.length][0], y: b[(i + 1) % b.length][1] }]);
}

function candidatePositions(venue, o) {
  const s = o.candidate_spacing_m, W = venue.width_m, H = venue.height_m;
  const boundary = venue.metadata?.walkable_boundary_m ?? null;
  const walls = wallSegs(venue);
  const excluded = (venue.zones ?? []).filter((z) => o.mounting.exclude_zone_types.includes(z.zone_type));
  const ok = (p) => {
    if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) return false;
    if (boundary && pointInPolygon(p, boundary) === "outside") return false;
    if ((venue.obstacles ?? []).some((ob) => pointInPolygon(p, ob.vertices) === "inside")) return false;
    if (excluded.some((z) => pointInPolygon(p, z.polygon) !== "outside")) return false;
    return walls.every(([a, b]) => distancePointSegment(p, a, b) >= o.min_wall_clearance_m);
  };
  const raw = [];
  if (o.mounting.mode === "wall_mounted") {
    const d = o.min_wall_clearance_m + 0.05;
    for (const [a, b] of [...walls, ...boundaryEdges(venue)]) {
      const L = distance(a, b);
      if (L <= 0) continue;
      const nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L, n = Math.max(1, Math.ceil(L / s));
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n, x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        raw.push({ x: x + nx * d, y: y + ny * d }, { x: x - nx * d, y: y - ny * d });
      }
    }
  } else {
    for (let x = s / 2; x <= W; x += s) for (let y = s / 2; y <= H; y += s) raw.push({ x, y });
  }
  const seen = new Set(), out = [];
  for (const p of raw) {
    const key = `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
    if (!seen.has(key) && ok(p)) { seen.add(key); out.push({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }); }
  }
  return out.sort((p, q) => p.x - q.x || p.y - q.y);
}

/**
 * Precompute everything the search needs.
 * @param venue contract-9.1 venue (e.g. from toVenue); anchors in it are ignored.
 * @param opts {max_range_m (required), resolution_m, candidate_spacing_m, min_wall_clearance_m, mounting,
 *              required_usable_anchors, required_per_cell(center)->number (D5 hook), max_pairs}
 */
export function buildCoverageProblem(venue, opts) {
  const o = { ...DEFAULTS, ...opts, mounting: { ...DEFAULTS.mounting, ...(opts.mounting ?? {}) } };
  positive("Maximum range", o.max_range_m); positive("Grid resolution", o.resolution_m);
  positive("Candidate spacing", o.candidate_spacing_m);
  o.required_usable_anchors = o.required_usable_anchors ?? MIN_USABLE_ANCHORS;
  const grid = buildGrid(venue, o.resolution_m, { boundary: venue.metadata?.walkable_boundary_m ?? null, obstacles: venue.obstacles ?? [] });
  if (grid.walkableCount === 0) throw new RangeError("There is no walkable area at this resolution. Use a finer grid or check the floor boundary.");
  const cells = new Int32Array(grid.walkableCount);
  for (let i = 0, n = 0; i < grid.walkable.length; i++) if (grid.walkable[i]) cells[n++] = i;
  const N = cells.length;
  const compactOf = new Int32Array(grid.walkable.length).fill(-1);
  cells.forEach((g, c) => { compactOf[g] = c; });
  const centre = (c) => grid.cellCenter(cells[c] % grid.nx, Math.floor(cells[c] / grid.nx));

  const candidates = candidatePositions(venue, o);
  if (!candidates.length) throw new RangeError("No valid anchor positions with these mounting settings. Loosen the mounting constraints or reduce the candidate spacing.");
  if (candidates.length * N > o.max_pairs)
    throw new RangeError(`This needs ${candidates.length} candidates x ${N} cells = ${candidates.length * N} visibility checks (limit ${o.max_pairs}). Use a coarser grid or larger candidate spacing.`);

  // D5 hook: pair_range_factor(anchor, cellCentre) -> factor in (0, 1]. A pair is usable only when
  // distance <= max_range_m * factor. Without the hook every pair keeps the full range (D4 behaviour).
  const factorOf = typeof o.pair_range_factor === "function" ? o.pair_range_factor : null;
  const vis = candidates.map((p) => {
    const flags = computeVisibility(p, grid, venue, o.max_range_m), list = [];
    for (let c = 0; c < N; c++) {
      if (!flags[cells[c]]) continue;
      if (factorOf) { const q = centre(c); if (distance(p, q) > o.max_range_m * factorOf(p, q)) continue; }
      list.push(c);
    }
    return Int32Array.from(list);
  });
  const required = new Uint8Array(N).fill(o.required_usable_anchors);
  if (typeof o.required_per_cell === "function") for (let c = 0; c < N; c++) required[c] = o.required_per_cell(centre(c));

  const seeingCounts = new Int32Array(N);
  vis.forEach((v) => v.forEach((c) => seeingCounts[c]++));
  const seeing = Array.from({ length: N }, (_, c) => new Int32Array(seeingCounts[c]));
  const fill = new Int32Array(N);
  vis.forEach((v, j) => v.forEach((c) => { seeing[c][fill[c]++] = j; }));
  let infeasible = 0;
  for (let c = 0; c < N; c++) if (seeingCounts[c] < required[c]) infeasible++;
  const maxCover = vis.reduce((m, v) => Math.max(m, v.length), 0);

  return { venue, options: o, grid, cells, N, centre, candidates, vis, seeing, required, maxCover, infeasible,
    sumRequired: required.reduce((s, r) => s + r, 0), maxRequired: Math.max(...required) };
}

/** Valid lower bound on anchors for this candidate set: capacity bound and the per-cell requirement. */
export function lowerBound(p) {
  return p.maxCover === 0 ? Infinity : Math.max(p.maxRequired, Math.ceil(p.sumRequired / p.maxCover));
}

/** Usable-anchor count per cell for a layout (array of candidate indices). */
export function layoutCounts(p, layout) {
  const count = new Int16Array(p.N);
  for (const j of layout) for (const c of p.vis[j]) count[c]++;
  return count;
}

/** Coverage metrics of a layout. Worst-case point = cell with the smallest (count - required), first on ties. */
export function evaluateLayout(p, layout) {
  const count = layoutCounts(p, layout);
  let uncovered = 0, worst = 0, worstMargin = Infinity;
  const hist = { 0: 0, 1: 0, 2: 0, 3: 0, "4_or_more": 0 };
  for (let c = 0; c < p.N; c++) {
    const margin = count[c] - p.required[c];
    if (margin < 0) uncovered++;
    if (margin < worstMargin) { worstMargin = margin; worst = c; }
    hist[count[c] >= 4 ? "4_or_more" : count[c]]++;
  }
  const res = p.grid.resolution_m, w = p.centre(worst);
  return {
    walkable_cells: p.N, walkable_area_m2: p.N * res * res,
    uncovered_cells: uncovered, uncovered_fraction: uncovered / p.N, uncovered_area_m2: uncovered * res * res,
    worst_case: { x_m: w.x, y_m: w.y, usable_anchors: count[worst], required: p.required[worst] },
    usable_anchor_histogram: hist, counts: count, criterion_met: uncovered === 0,
  };
}

/** Evenly spaced layout of k anchors, snapped to the nearest unused candidate. The comparison baseline. */
export function naiveGridLayout(p, k) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let c = 0; c < p.N; c++) { const q = p.centre(c); minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); }
  const w = Math.max(maxX - minX, 1e-9), h = Math.max(maxY - minY, 1e-9);
  const cols = Math.max(1, Math.ceil(Math.sqrt((k * w) / h))), rows = Math.max(1, Math.ceil(k / cols)), total = cols * rows;
  const targets = [];
  for (let t = 0; t < k; t++) {
    const idx = Math.floor((t * total) / k), i = idx % cols, j = Math.floor(idx / cols);
    targets.push({ x: minX + ((i + 0.5) / cols) * w, y: minY + ((j + 0.5) / rows) * h });
  }
  const used = new Set(), layout = [];
  for (const t of targets) {
    let best = -1, bd = Infinity;
    p.candidates.forEach((q, j) => { if (used.has(j)) return; const d = distance(q, t); if (d < bd) { bd = d; best = j; } });
    if (best >= 0) { used.add(best); layout.push(best); }
  }
  return layout;
}

/** Fewest naive-grid anchors (k from the lower bound up to maxK) that meet the criterion, or null. */
export function naiveMinAnchors(p, maxK) {
  for (let k = Math.max(1, lowerBound(p)); k <= maxK; k++) {
    if (k > p.candidates.length) break;
    if (evaluateLayout(p, naiveGridLayout(p, k)).criterion_met) return k;
  }
  return null;
}

/** Put chosen positions into a venue (contract 9.1). Refuses more than 8 anchors (model input limit). */
export function venueWithAnchors(venue, positions) {
  if (positions.length > MAX_ANCHOR_SLOTS)
    throw new RangeError(`This layout needs ${positions.length} anchors, but the model contract supports at most ${MAX_ANCHOR_SLOTS}. Reduce the range requirement, split the venue, or request a contract change.`);
  const anchors = positions.map((q, i) => ({ anchor_id: i, x_m: q.x, y_m: q.y, enabled: true, anchor_type: "ceiling" }));
  return { ...venue, anchors };
}
