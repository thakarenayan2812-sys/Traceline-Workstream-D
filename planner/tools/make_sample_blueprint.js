// Draws fixtures/sample_blueprint.png (a synthetic floor plan, 1200 x 800 px at 20 px/m, with a scale bar
// exactly 10.0 m long) and traces fixtures/sample_plan.json by running the REAL editor and exporter on it.
// Deterministic: no randomness; created_at is a fixed constant so the output is byte-stable.
// Usage: node tools/make_sample_blueprint.js
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createEditor } from "../src/plan/editor.js";
import { buildPlanJson } from "../src/plan/plan_export.js";

const W = 1200, H = 800, PX_PER_M = 20, OX = 100, OY = 700;       // metre (0,0) sits at image px (100, 700)
const px = (x, y) => ({ x: OX + PX_PER_M * x, y: OY - PX_PER_M * y });

// ---- drawing
const img = new Uint8Array(W * H * 3).fill(255);
const rect = (x0, y0, x1, y1, [r, g, b]) => {
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(H - 1, Math.ceil(y1)); y++)
    for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(W - 1, Math.ceil(x1)); x++) { const i = (y * W + x) * 3; img[i] = r; img[i + 1] = g; img[i + 2] = b; }
};
const line = (a, b, t, col) => rect(Math.min(a.x, b.x) - t / 2, Math.min(a.y, b.y) - t / 2, Math.max(a.x, b.x) + t / 2, Math.max(a.y, b.y) + t / 2, col);
const DARK = [40, 40, 48], GREY = [150, 150, 160];

const walls = [  // metres, same geometry is traced below
  [[0, 0], [50, 0]], [[50, 0], [50, 30]], [[50, 30], [0, 30]], [[0, 30], [0, 0]],
  [[15, 0], [15, 20]], [[35, 10], [35, 30]],
];
for (const [a, b] of walls) line(px(...a), px(...b), 6, DARK);
// shelf, 10 x 2 m
rect(px(20, 16).x, px(20, 16).y, px(30, 14).x, px(30, 14).y, GREY);
// scale bar: 200 px = 10.0 m, at image y = 750, with end ticks
line({ x: 100, y: 750 }, { x: 300, y: 750 }, 4, DARK);
line({ x: 100, y: 740 }, { x: 100, y: 760 }, 4, DARK);
line({ x: 300, y: 740 }, { x: 300, y: 760 }, 4, DARK);

// ---- minimal PNG encoder
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; Buffer.from(img.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1); }
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);

const fx = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
writeFileSync(join(fx, "sample_blueprint.png"), png);
const sha256 = createHash("sha256").update(png).digest("hex");

// ---- trace it through the real editor
const ed = createEditor();
ed.setImage({ filename: "sample_blueprint.png", width_px: W, height_px: H, sha256 });
ed.setTool("calibrate"); ed.click({ x: 100, y: 750 }); ed.click({ x: 300, y: 750 }); ed.setKnownDistance(10);
ed.setTool("boundary"); [[0, 0], [50, 0], [50, 30], [0, 30]].forEach(([x, y]) => ed.click(px(x, y))); ed.finish();
ed.setTool("wall"); ed.setOption("chain_walls", false); ed.setOption("wall_material", "concrete");
for (const [a, b] of walls.slice(0, 4)) { ed.click(px(...a)); ed.click(px(...b)); }
ed.setOption("wall_material", "drywall");
for (const [a, b] of walls.slice(4)) { ed.click(px(...a)); ed.click(px(...b)); }
ed.setTool("obstacle"); [[20, 14], [30, 14], [30, 16], [20, 16]].forEach(([x, y]) => ed.click(px(x, y))); ed.finish();
ed.setTool("crowd_circle"); ed.setOption("zone_name", "Entrance crowd"); ed.click(px(7, 6)); ed.click(px(12, 6));

const plan = buildPlanJson(ed.snapshot().plan, { created_at: "2026-10-18T00:00:00.000Z" });
writeFileSync(join(fx, "sample_plan.json"), JSON.stringify(plan, null, 2) + "\n");
console.log(`Wrote sample_blueprint.png (${png.length} bytes, sha256 ${sha256.slice(0, 12)}...) and sample_plan.json (${plan.transform.width_m} x ${plan.transform.height_m} m, ${plan.validation.warnings.length} warnings).`);
