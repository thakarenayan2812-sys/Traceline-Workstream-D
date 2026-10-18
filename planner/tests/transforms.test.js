import test from "node:test";
import assert from "node:assert/strict";
import { metresToPixels, pixelsToMetres, fitView, scaleFromKnownDistance,
  imagePxToMetres, metresToImagePx, inBounds } from "../src/core/transforms.js";

const near = (a, b, e = 1e-9) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test("pixel_y follows the contract formula", () => {
  const view = { height_m: 20, px_per_m: 10 };
  assert.deepEqual(metresToPixels({ x: 3, y: 0 }, view), { x: 30, y: 200 });
  assert.deepEqual(metresToPixels({ x: 0, y: 20 }, view), { x: 0, y: 0 });
});

test("round trip metres -> pixels -> metres", () => {
  const view = { height_m: 20, px_per_m: 7.3, offset_px: { x: 12, y: 5 } };
  for (const p of [{ x: 0, y: 0 }, { x: 29.5, y: 19.25 }, { x: 15.123, y: 4.5 }]) {
    const b = pixelsToMetres(metresToPixels(p, view), view);
    near(b.x, p.x); near(b.y, p.y);
  }
});

test("fitView keeps the whole venue inside the canvas", () => {
  const venue = { width_m: 30, height_m: 20 };
  const v = fitView(venue, 900, 500, 16);
  const tl = metresToPixels({ x: 0, y: 20 }, v), br = metresToPixels({ x: 30, y: 0 }, v);
  assert.ok(tl.x >= 0 && tl.y >= 0 && br.x <= 900 && br.y <= 500);
});

test("scale calibration", () => {
  near(scaleFromKnownDistance({ x: 0, y: 0 }, { x: 300, y: 400 }, 10), 0.02);
  assert.throws(() => scaleFromKnownDistance({ x: 1, y: 1 }, { x: 1, y: 1 }, 5), RangeError);
  assert.throws(() => scaleFromKnownDistance({ x: 0, y: 0 }, { x: 5, y: 0 }, 0), RangeError);
  assert.throws(() => scaleFromKnownDistance({ x: 0, y: 0 }, { x: 5, y: 0 }, NaN), RangeError);
});

test("image pixels <-> metres flips y and round-trips", () => {
  const origin = { x: 100, y: 800 }, s = 0.05;
  const m = imagePxToMetres({ x: 300, y: 600 }, origin, s);
  near(m.x, 10); near(m.y, 10);
  const px = metresToImagePx(m, origin, s);
  near(px.x, 300); near(px.y, 600);
});

test("inBounds is inclusive", () => {
  const v = { width_m: 30, height_m: 20 };
  assert.ok(inBounds({ x: 0, y: 20 }, v));
  assert.ok(!inBounds({ x: 30.01, y: 5 }, v));
  assert.ok(!inBounds({ x: -0.01, y: 5 }, v));
});
