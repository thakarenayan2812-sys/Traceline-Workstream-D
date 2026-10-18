import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fitViewport, imageToScreen, screenToImage, zoomAt, panBy } from "../src/plan/viewport.js";
import { sniffImageType, validateImageFile, validateImageSize } from "../src/plan/image_check.js";
import { createPlan, reducePlan, createHistory, commit, undo, redo } from "../src/plan/plan_model.js";
import { validatePlan, metresPerPixel } from "../src/plan/plan_validate.js";
import { buildPlanJson, toVenue, planFromJson, circlePolygon, PlanValidationError } from "../src/plan/plan_export.js";
import { createEditor } from "../src/plan/editor.js";
import { polygonIsSimple, polygonArea, buildGrid, lineOfSight } from "../src/core/geometry.js";
import { validateVenue } from "../src/core/validate.js";

const fx = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);
const AT = "2026-10-18T00:00:00.000Z";

/** Trace a simple plan through the real editor: 1000x800 image, 100 px = 5 m (0.05 m/px). */
function tracedEditor({ known = 5, rect = [[100, 100], [900, 100], [900, 700], [100, 700]], walls = [[[500, 100], [500, 400]]] } = {}) {
  const ed = createEditor();
  ed.setImage({ filename: "t.png", width_px: 1000, height_px: 800, sha256: "abc" });
  ed.click({ x: 100, y: 750 }); ed.click({ x: 200, y: 750 }); ed.setKnownDistance(known);
  ed.setTool("boundary"); rect.forEach(([x, y]) => ed.click({ x, y })); ed.finish();
  ed.setTool("wall"); ed.setOption("chain_walls", false);
  for (const [a, b] of walls) { ed.click({ x: a[0], y: a[1] }); ed.click({ x: b[0], y: b[1] }); }
  return ed;
}

test("viewport: fit, round trip and zoom keeps the anchor point fixed", () => {
  const vp = fitViewport(1200, 800, 600, 400);
  near(vp.scale, (600 - 16) / 1200 < (400 - 16) / 800 ? (600 - 16) / 1200 : (400 - 16) / 800);
  const p = { x: 321, y: 654 };
  const back = screenToImage(imageToScreen(p, vp), vp);
  near(back.x, p.x); near(back.y, p.y);
  const s = { x: 200, y: 150 };
  const before = screenToImage(s, vp);
  const z = zoomAt(vp, s, 3);
  const after = screenToImage(s, z);
  near(before.x, after.x, 1e-6); near(before.y, after.y, 1e-6);
  assert.equal(zoomAt(vp, s, 1e9).scale, 40);
  assert.equal(panBy(vp, 5, -7).tx, vp.tx + 5);
});

test("image checks look at real bytes, size and dimensions", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  assert.equal(sniffImageType(png), "png"); assert.equal(sniffImageType(jpg), "jpeg");
  assert.equal(sniffImageType(gif), null); assert.equal(sniffImageType(new Uint8Array(2)), null);
  assert.deepEqual(validateImageFile({ size_bytes: 100, bytes: png }), []);
  assert.match(validateImageFile({ size_bytes: 100, bytes: gif })[0], /not a PNG or JPEG/);
  assert.match(validateImageFile({ size_bytes: 0, bytes: png })[0], /empty/);
  assert.match(validateImageFile({ size_bytes: 30 * 1024 * 1024, bytes: png })[0], /larger than/);
  assert.equal(validateImageSize(1200, 800).length, 0);
  assert.equal(validateImageSize(100, 800).length, 1);
  assert.equal(validateImageSize(20000, 800).length, 1);
});

test("reducer, ids and history", () => {
  let h = createHistory(reducePlan(createPlan(), { type: "SET_IMAGE", image: { filename: "a.png", width_px: 500, height_px: 500 } }));
  h = commit(h, reducePlan(h.present, { type: "ADD_WALL", a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }));
  h = commit(h, reducePlan(h.present, { type: "ADD_WALL", a: { x: 0, y: 5 }, b: { x: 10, y: 5 } }));
  assert.deepEqual(h.present.walls.map((w) => w.wall_id), ["wall_001", "wall_002"]);
  h = undo(h); assert.equal(h.present.walls.length, 1);
  h = redo(h); assert.equal(h.present.walls.length, 2);
  h = undo(undo(h)); assert.equal(h.present.walls.length, 0);
  assert.equal(undo(h), h);                                   // nothing left to undo
  h = commit(h, reducePlan(h.present, { type: "ADD_WALL", a: { x: 1, y: 1 }, b: { x: 2, y: 2 } }));
  assert.equal(h.future.length, 0);                           // new action clears redo
  assert.throws(() => reducePlan(h.present, { type: "NOPE" }), RangeError);
  assert.throws(() => reducePlan(h.present, { type: "ADD_ZONE", zone_type: "bogus", vertices: [] }), RangeError);
});

test("polygonIsSimple", () => {
  assert.ok(polygonIsSimple([[0, 0], [10, 0], [10, 10], [0, 10]]));
  assert.ok(polygonIsSimple([[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]));
  assert.ok(!polygonIsSimple([[0, 0], [10, 10], [10, 0], [0, 10]]));      // bow tie
  assert.ok(!polygonIsSimple([[0, 0], [10, 0], [5, 0]]));                 // doubles back
  assert.ok(!polygonIsSimple([[0, 0], [10, 0], [10, 0], [10, 10]]));      // repeated vertex
  assert.ok(!polygonIsSimple([[0, 0], [10, 0]]));
});

test("validation: each missing piece is reported in plain words, nothing is invented", () => {
  const empty = validatePlan(createPlan());
  assert.ok(empty.errors.length >= 4);
  assert.equal(empty.metres_per_px, null);
  const ed = createEditor();
  ed.setImage({ filename: "t.png", width_px: 1000, height_px: 800 });
  ed.click({ x: 100, y: 100 });
  const v = validatePlan(ed.snapshot().plan);
  assert.ok(v.errors.some((e) => /two points/.test(e)));
  assert.ok(v.errors.some((e) => /real distance/.test(e)));
  assert.equal(metresPerPixel({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, known_m: 5 }), null);
});

test("validation: crossing boundary is an error; no walls and short baseline are warnings", () => {
  const bow = tracedEditor({ rect: [[100, 100], [900, 700], [900, 100], [100, 700]], walls: [] });
  assert.ok(validatePlan(bow.snapshot().plan).errors.some((e) => /crosses itself/.test(e)));
  const ok = tracedEditor({ walls: [] });
  const w = validatePlan(ok.snapshot().plan).warnings;
  assert.ok(w.some((m) => /No walls are traced/.test(m)));
  assert.ok(w.some((m) => /only 100 px apart/.test(m)) === false);   // 1% error: below the 2% threshold
  const short = createEditor();
  short.setImage({ filename: "t.png", width_px: 1000, height_px: 800 });
  short.click({ x: 100, y: 750 }); short.click({ x: 120, y: 750 }); short.setKnownDistance(1);
  short.setTool("boundary"); [[100, 100], [900, 100], [900, 700]].forEach(([x, y]) => short.click({ x, y })); short.finish();
  assert.ok(validatePlan(short.snapshot().plan).warnings.some((m) => /only 20 px apart/.test(m)));
});

test("export maths: known scale, y flip, origin at bottom-left of traced bounds", () => {
  const p = buildPlanJson(tracedEditor().snapshot().plan, { created_at: AT });
  near(p.scale.metres_per_px, 0.05);
  assert.equal(p.transform.width_m, 40); assert.equal(p.transform.height_m, 30);
  assert.deepEqual(p.transform.origin_px, { x: 100, y: 700 });
  assert.deepEqual(p.geometry.boundary_m, [[0, 30], [40, 30], [40, 0], [0, 0]]);       // image top is metre-y 30
  assert.deepEqual(p.geometry.walls_m[0].a, [20, 30]);
  assert.deepEqual(p.geometry.walls_m[0].b, [20, 15]);
  assert.equal(p.planner_settings.required_usable_anchors, 3);
  assert.equal(p.planner_settings.max_range_m, null);                                  // no invented defaults
  assert.ok(p.notes.some((n) => /not uploaded/.test(n)));
});

test("different calibrations and tracings give different results", () => {
  const a = buildPlanJson(tracedEditor({ known: 5 }).snapshot().plan, { created_at: AT });
  const b = buildPlanJson(tracedEditor({ known: 10 }).snapshot().plan, { created_at: AT });
  const c = buildPlanJson(tracedEditor({ rect: [[100, 100], [500, 100], [500, 700], [100, 700]] }).snapshot().plan, { created_at: AT });
  assert.equal(b.transform.width_m, 2 * a.transform.width_m);
  assert.equal(c.transform.width_m, 20);
});

test("export is deterministic and refuses an invalid plan", () => {
  const plan = tracedEditor().snapshot().plan;
  assert.equal(JSON.stringify(buildPlanJson(plan, { created_at: AT })), JSON.stringify(buildPlanJson(plan, { created_at: AT })));
  assert.throws(() => buildPlanJson(createPlan()), PlanValidationError);
});

test("plan.json round trips through planFromJson", () => {
  const ed = tracedEditor();
  const first = buildPlanJson(ed.snapshot().plan, { created_at: AT });
  const second = buildPlanJson(planFromJson(first), { created_at: AT });
  assert.deepEqual(second, first);
  assert.throws(() => planFromJson({ plan_kind: "other" }), /not a Traceline plan/);
  assert.throws(() => planFromJson({ ...first, schema_version: "9.9" }), /Unsupported/);
});

test("venue export satisfies the venue contract and works with D2 geometry", () => {
  const venue = toVenue(tracedEditor().snapshot().plan, { created_at: AT });
  assert.deepEqual(validateVenue(venue), []);
  assert.equal(venue.venue_id, "custom"); assert.deepEqual(venue.anchors, []);
  assert.equal(venue.walls[0].x1_m, 20);
  const grid = buildGrid(venue, 1, { boundary: venue.metadata.walkable_boundary_m });
  assert.equal(grid.walkableCount, 40 * 30);
  assert.equal(lineOfSight({ x: 5, y: 25 }, { x: 35, y: 25 }, venue).blocked, true);    // crosses the wall (y 15 to 30)
  assert.equal(lineOfSight({ x: 5, y: 5 }, { x: 35, y: 5 }, venue).blocked, false);     // passes below the wall end
});

test("editor: scale clicks, restart on third click, and tiny gaps rejected", () => {
  const ed = createEditor();
  assert.equal(ed.click({ x: 5, y: 5 }).ok, false);                    // no image yet
  ed.setImage({ filename: "t.png", width_px: 1000, height_px: 800 });
  assert.equal(ed.click({ x: 2000, y: 5 }).ok, false);                 // outside image
  ed.click({ x: 100, y: 100 });
  assert.equal(ed.click({ x: 100.5, y: 100 }).ok, false);              // too close
  ed.click({ x: 300, y: 100 });
  const c = ed.snapshot().plan.calibration; assert.deepEqual([c.a.x, c.b.x], [100, 300]);
  ed.click({ x: 50, y: 50 });                                           // third click restarts
  const c2 = ed.snapshot().plan.calibration; assert.equal(c2.b, null); assert.equal(c2.a.x, 50);
});

test("editor: polygons need 3 points; walls chain; crowd circle has the right area", () => {
  const ed = createEditor();
  ed.setImage({ filename: "t.png", width_px: 1000, height_px: 800 });
  ed.setTool("obstacle"); ed.click({ x: 10, y: 10 }); ed.click({ x: 50, y: 10 });
  assert.equal(ed.finish().ok, false);
  ed.click({ x: 50, y: 50 }); assert.equal(ed.finish().ok, true);
  assert.equal(ed.snapshot().plan.obstacles.length, 1);
  ed.setTool("wall");
  ed.click({ x: 100, y: 100 }); ed.click({ x: 200, y: 100 }); ed.click({ x: 200, y: 200 });
  assert.equal(ed.snapshot().plan.walls.length, 2);                    // chained: second wall starts at the first's end
  assert.deepEqual(ed.snapshot().plan.walls[1].a, { x: 200, y: 100 });
  ed.setTool("crowd_circle"); ed.setOption("density_people_m2", 3);
  ed.click({ x: 500, y: 400 }); ed.click({ x: 600, y: 400 });
  const z = ed.snapshot().plan.zones[0];
  assert.equal(z.zone_type, "crowd"); assert.equal(z.shape, "circle"); assert.equal(z.density_people_m2, 3);
  const area = polygonArea(z.vertices.map((p) => [p.x, p.y]));
  assert.ok(Math.abs(area - Math.PI * 100 * 100) / (Math.PI * 100 * 100) < 0.01);
  near(circlePolygon({ x: 0, y: 0 }, 10, 8).length, 8);
});

test("editor: undo, redo, delete, reset and new image", () => {
  const ed = tracedEditor();
  const n = ed.snapshot().plan.walls.length;
  ed.undo(); assert.equal(ed.snapshot().plan.walls.length, n - 1);
  ed.redo(); assert.equal(ed.snapshot().plan.walls.length, n);
  ed.deleteItem("wall", "wall_001"); assert.equal(ed.snapshot().plan.walls.length, 0);
  ed.undo(); assert.equal(ed.snapshot().plan.walls.length, 1);
  ed.reset();
  const s = ed.snapshot();
  assert.equal(s.plan.boundary, null); assert.equal(s.plan.calibration.a, null); assert.ok(s.plan.image);
  ed.undo(); assert.ok(ed.snapshot().plan.boundary);                  // reset itself is undoable
  ed.setImage({ filename: "new.png", width_px: 600, height_px: 600 });
  assert.equal(ed.snapshot().canUndo, false); assert.equal(ed.snapshot().plan.walls.length, 0);
});

test("editor: crowd density outside 0 to 4 blocks export", () => {
  const ed = tracedEditor();
  ed.setTool("crowd_circle"); ed.setOption("density_people_m2", 9);
  ed.click({ x: 400, y: 300 }); ed.click({ x: 450, y: 300 });
  assert.ok(validatePlan(ed.snapshot().plan).errors.some((e) => /between 0 and 4/.test(e)));
});

test("sample plan matches its image and regenerates identically", () => {
  const png = readFileSync(join(fx, "sample_blueprint.png"));
  const saved = JSON.parse(readFileSync(join(fx, "sample_plan.json"), "utf8"));
  assert.equal(saved.source_image.sha256, createHash("sha256").update(png).digest("hex"));
  near(saved.scale.metres_per_px, 0.05);
  assert.equal(saved.transform.width_m, 50); assert.equal(saved.transform.height_m, 30);
  assert.deepEqual(buildPlanJson(planFromJson(saved), { created_at: saved.created_at }), saved);
  assert.equal(saved.geometry.zones_m[0].shape, "circle");
  assert.deepEqual(validateVenue(toVenue(planFromJson(saved), { created_at: saved.created_at })), []);
});
