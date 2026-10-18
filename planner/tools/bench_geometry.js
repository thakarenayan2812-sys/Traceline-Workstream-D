// Re-runnable timing of grid + visibility on synthetic walls. Numbers depend on the machine;
// quote them only with the machine, Node version and these parameters.
// Usage: node tools/bench_geometry.js
import { buildGrid, computeVisibility } from "../src/core/geometry.js";
import { rng } from "../src/core/rng.js";

const W = 100, H = 60, SEED = 1;
const r = rng(SEED);
const walls = Array.from({ length: 60 }, (_, i) => {
  const x = r() * W, y = r() * H, horizontal = r() < 0.5, l = 3 + r() * 12;
  return { wall_id: `w${i}`, x1_m: x, y1_m: y, x2_m: horizontal ? Math.min(W, x + l) : x, y2_m: horizontal ? y : Math.min(H, y + l) };
});
for (const res of [1, 0.5, 0.25]) {
  const t0 = performance.now();
  const grid = buildGrid({ width_m: W, height_m: H }, res);
  const t1 = performance.now();
  computeVisibility({ x: W / 2, y: H / 2 }, grid, { walls }, 30);
  const t2 = performance.now();
  console.log(`venue ${W}x${H} m, ${walls.length} walls, res ${res} m: ${grid.nx * grid.ny} cells, grid ${(t1 - t0).toFixed(0)} ms, one anchor visibility ${(t2 - t1).toFixed(0)} ms`);
}
console.log(`node ${process.version}, seed ${SEED}`);
