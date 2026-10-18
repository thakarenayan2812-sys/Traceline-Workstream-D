import test from "node:test";
import assert from "node:assert/strict";
import { segmentIntersection, segmentBlockedByEdge, lineOfSight, pointInPolygon, polygonArea,
  polygonSignedArea, segmentBlockedByPolygon, buildGrid, computeVisibility, distancePointSegment } from "../src/core/geometry.js";
import { rng } from "../src/core/rng.js";

const P = (x, y) => ({ x, y });
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test("proper crossing returns the crossing point", () => {
  const h = segmentIntersection(P(0, 0), P(10, 10), P(0, 10), P(10, 0));
  assert.equal(h.kind, "point"); near(h.point.x, 5); near(h.point.y, 5);
});

test("disjoint segments do not intersect", () => {
  assert.equal(segmentIntersection(P(0, 0), P(1, 0), P(0, 1), P(1, 1)).kind, "none");
  assert.equal(segmentIntersection(P(0, 0), P(4, 0), P(5, -1), P(5, 1)).kind, "none");
});

test("touching endpoints: T-junction and end-to-end are single points", () => {
  const t = segmentIntersection(P(0, 0), P(10, 0), P(5, 0), P(5, 5));
  assert.equal(t.kind, "point"); near(t.point.x, 5); near(t.point.y, 0);
  const e = segmentIntersection(P(0, 0), P(5, 0), P(5, 0), P(9, 3));
  assert.equal(e.kind, "point"); near(e.point.x, 5);
});

test("gaps below the tolerance count as touching, above do not", () => {
  assert.equal(segmentIntersection(P(0, 0), P(5, 0), P(5.0000005, -1), P(5.0000005, 1)).kind, "point");
  assert.equal(segmentIntersection(P(0, 0), P(5, 0), P(5.001, -1), P(5.001, 1)).kind, "none");
});

test("collinear: overlap, disjoint and end-touching", () => {
  const o = segmentIntersection(P(0, 0), P(10, 0), P(5, 0), P(15, 0));
  assert.equal(o.kind, "overlap"); near(o.from.x, 5); near(o.to.x, 10);
  assert.equal(segmentIntersection(P(0, 0), P(4, 0), P(5, 0), P(9, 0)).kind, "none");
  assert.equal(segmentIntersection(P(0, 0), P(5, 0), P(5, 0), P(9, 0)).kind, "point");
  // reversed direction must give the same answer
  assert.equal(segmentIntersection(P(10, 0), P(0, 0), P(15, 0), P(5, 0)).kind, "overlap");
});

test("near-parallel: shallow crossing is found, offset parallel is not", () => {
  const h = segmentIntersection(P(0, 0), P(100, 0.001), P(0, 0.0005), P(100, 0));
  assert.equal(h.kind, "point"); near(h.point.x, 100 / 3, 1e-3);
  assert.equal(segmentIntersection(P(0, 0), P(100, 0.001), P(0, 1), P(100, 1.001)).kind, "none");
  assert.equal(segmentIntersection(P(0, 0), P(10, 0), P(0, 0.001), P(10, 0.001)).kind, "none");
});

test("zero-length segments behave as points", () => {
  assert.equal(segmentIntersection(P(5, 0), P(5, 0), P(0, 0), P(10, 0)).kind, "point");
  assert.equal(segmentIntersection(P(5, 1), P(5, 1), P(0, 0), P(10, 0)).kind, "none");
  assert.equal(segmentIntersection(P(2, 2), P(2, 2), P(2, 2), P(2, 2)).kind, "point");
});

test("intersection agrees with the classic orientation test on 3000 random pairs", () => {
  const r = rng(11);
  const rp = () => P(r() * 20, r() * 20);
  const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let n = 0; n < 3000; n++) {
    const a = rp(), b = rp(), c = rp(), d = rp();
    const classic = orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
    assert.equal(segmentIntersection(a, b, c, d).kind !== "none", classic);
  }
});

const wall = { wall_id: "w", x1_m: 10, y1_m: 0, x2_m: 10, y2_m: 14, material: "drywall" };
const blocked = (a, t) => segmentBlockedByEdge(a, t, P(wall.x1_m, wall.y1_m), P(wall.x2_m, wall.y2_m));

test("LOS: crossing a wall blocks, clear path does not", () => {
  assert.ok(blocked(P(5, 5), P(15, 5)));
  assert.ok(!blocked(P(5, 5), P(9, 5)));
  assert.ok(!blocked(P(5, 15), P(15, 15)));      // passes above the wall end
});

test("LOS policy P3: contact at the segment's own endpoint does not block", () => {
  assert.ok(!blocked(P(10, 0), P(15, 5)));       // anchor on the wall end
  assert.ok(!blocked(P(10, 7), P(15, 7)));       // anchor on the wall face, looks right
  assert.ok(!blocked(P(10, 7), P(5, 7)));        // same anchor looks left
  assert.ok(!blocked(P(5, 5), P(10, 7)));        // target standing at the wall
});

test("LOS policies P4 and P5: grazing a wall end or running along it blocks", () => {
  assert.ok(blocked(P(5, 14), P(15, 14)));       // passes exactly through the wall end
  assert.ok(blocked(P(10, 2), P(10, 10)));       // runs along the wall
  assert.ok(!blocked(P(10, 16), P(10, 20)));     // collinear but beyond the wall
});

test("LOS is symmetric for 2000 random anchor/target pairs", () => {
  const r = rng(5);
  const geom = { walls: [wall, { wall_id: "w2", x1_m: 20, y1_m: 6, x2_m: 20, y2_m: 20 }, { wall_id: "w3", x1_m: 0, y1_m: 10, x2_m: 30, y2_m: 11 }] };
  for (let n = 0; n < 2000; n++) {
    const a = P(r() * 30, r() * 20), t = P(r() * 30, r() * 20);
    assert.equal(lineOfSight(a, t, geom).blocked, lineOfSight(t, a, geom).blocked);
  }
});

test("lineOfSight reports every blocker by id", () => {
  const geom = { walls: [wall, { wall_id: "w2", x1_m: 20, y1_m: 0, x2_m: 20, y2_m: 14 }] };
  assert.deepEqual(lineOfSight(P(5, 5), P(25, 5), geom), { blocked: true, blockers: ["w", "w2"] });
  assert.deepEqual(lineOfSight(P(5, 5), P(8, 5), geom), { blocked: false, blockers: [] });
});

const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
test("point in polygon: inside, outside, edge, vertex", () => {
  assert.equal(pointInPolygon(P(5, 5), square), "inside");
  assert.equal(pointInPolygon(P(11, 5), square), "outside");
  assert.equal(pointInPolygon(P(10, 5), square), "boundary");
  assert.equal(pointInPolygon(P(0, 0), square), "boundary");
});

test("point in polygon: concave L shape and rays through vertices", () => {
  const L = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  assert.equal(pointInPolygon(P(2, 8), L), "inside");
  assert.equal(pointInPolygon(P(8, 8), L), "outside");   // in the notch
  const diamond = [[5, 0], [10, 5], [5, 10], [0, 5]];
  assert.equal(pointInPolygon(P(2, 5), diamond), "inside");
  assert.equal(pointInPolygon(P(12, 5), diamond), "outside");
  assert.equal(pointInPolygon(P(-1, 5), diamond), "outside");
});

test("polygon area and winding", () => {
  near(polygonArea(square), 100);
  assert.ok(polygonSignedArea(square) > 0);
  assert.ok(polygonSignedArea([...square].reverse()) < 0);
});

const shelf = [[12, 12], [18, 12], [18, 13], [12, 13]];
test("obstacles are solid (policy P6)", () => {
  assert.ok(segmentBlockedByPolygon(P(15, 10), P(15, 15), shelf));       // crosses it
  assert.ok(segmentBlockedByPolygon(P(12, 12), P(18, 13), shelf));       // corner to corner, no edge crossing
  assert.ok(segmentBlockedByPolygon(P(15, 5), P(15, 12.5), shelf));      // target inside
  assert.ok(!segmentBlockedByPolygon(P(10, 14), P(20, 14), shelf));      // passes above
  assert.ok(!segmentBlockedByPolygon(P(15, 12), P(15, 8), shelf));       // leaves from its edge
});

test("grid: cell centres, counts and obstacle exclusion", () => {
  const g = buildGrid({ width_m: 30, height_m: 20 }, 1);
  assert.equal(g.nx, 30); assert.equal(g.ny, 20); assert.equal(g.walkableCount, 600);
  assert.deepEqual(g.cellCenter(0, 0), P(0.5, 0.5));
  const g2 = buildGrid({ width_m: 30, height_m: 20 }, 1, { obstacles: [{ vertices: shelf }] });
  assert.equal(g2.walkableCount, 594);
  assert.equal(g2.walkableAreaM2, 594);
});

test("grid: boundary polygon restricts the walkable area", () => {
  const g = buildGrid({ width_m: 10, height_m: 10 }, 1, { boundary: [[0, 0], [10, 0], [10, 4], [0, 4]] });
  assert.equal(g.walkableCount, 40);
});

test("grid: cells whose centre is beyond the venue edge are not walkable", () => {
  assert.equal(buildGrid({ width_m: 10.2, height_m: 5 }, 1).walkableCount, 10 * 5);
  assert.equal(buildGrid({ width_m: 10.5, height_m: 5 }, 1).walkableCount, 11 * 5);
});

test("grid: bad resolution and oversize grids give clear errors", () => {
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => buildGrid({ width_m: 5, height_m: 5 }, bad), RangeError);
  assert.throws(() => buildGrid({ width_m: 1000, height_m: 1000 }, 0.1), /coarser resolution/);
});

test("visibility respects range and walls, and is deterministic", () => {
  const venue = { width_m: 30, height_m: 20 };
  const grid = buildGrid(venue, 1);
  const anchor = P(5, 10);
  const idx = (x, y) => grid.index(Math.floor(x), Math.floor(y));
  const open = computeVisibility(anchor, grid, {}, 8);
  assert.equal(open[idx(12.5, 10.5)], 1);        // 7.5 m away, no wall
  assert.equal(open[idx(0.5, 0.5)], 0);          // 10.5 m away, out of range
  const walled = { walls: [{ wall_id: "w", x1_m: 10, y1_m: 0, x2_m: 10, y2_m: 20 }] };
  const v = computeVisibility(anchor, grid, walled, 8);
  assert.equal(v[idx(12.5, 10.5)], 0);           // behind the wall
  assert.equal(v[idx(7.5, 10.5)], 1);
  assert.deepEqual(v, computeVisibility(anchor, grid, walled, 8));
  assert.throws(() => computeVisibility(anchor, grid, walled, 0), RangeError);
});

test("distancePointSegment", () => {
  near(distancePointSegment(P(5, 3), P(0, 0), P(10, 0)), 3);
  near(distancePointSegment(P(-3, 4), P(0, 0), P(10, 0)), 5);
});
