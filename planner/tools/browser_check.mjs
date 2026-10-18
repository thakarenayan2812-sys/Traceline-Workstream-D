// D planner browser check (optional; needs the Playwright package, see demo/tools/browser_check.mjs).
// Loads the saved sample plan, runs the coverage search and the anchor placement optimizer in Chromium,
// and checks the results, the exports, phone-width layout and the absence of console errors.
// Usage: node tools/browser_check.mjs     (env PLAYWRIGHT_PATH to point at the playwright package)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const PLAN = join(here, "..", "fixtures", "sample_plan.json");
const PORT = Number(process.env.PORT ?? 8094);

async function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const target = process.env.PLAYWRIGHT_PATH ?? "playwright";
  try { return req(target); } catch { /* ESM path below */ }
  return import(pathToFileURL(target).href).catch(() => {
    throw new Error("Playwright not found. Install it, or set PLAYWRIGHT_PATH to its package path.");
  });
}

const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failures.push(msg); };
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", repoRoot], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
let browser;
try {
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://localhost:${PORT}/planner/`, { waitUntil: "networkidle" });

  // A saved plan needs its original image first (the image is not copied into plan.json).
  await page.setInputFiles("#file", join(here, "..", "fixtures", "sample_blueprint.png"));
  await page.waitForTimeout(400);
  await page.setInputFiles("#load-plan", PLAN);
  await page.waitForTimeout(400);
  const probs = await page.textContent("#problems");
  check(!/Problem:/.test(probs), `saved sample plan loads with no problems${/Problem:/.test(probs) ? ": " + probs : ""}`);

  await page.fill("#range", "15");
  await page.dispatchEvent("#range", "input");
  await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 30000 });
  await page.click("#run");
  await page.waitForFunction(() => !document.getElementById("export-report").disabled, null, { timeout: 240000 });
  check(true, "coverage search finishes on the sample plan");

  // The sample plan has a crowd zone with no density, so a fallback density must be entered (same as make optimize FALLBACK=2).
  await page.fill("#c-fallback", "2");
  await page.dispatchEvent("#c-fallback", "input");
  await page.waitForFunction(() => !document.getElementById("o-run").disabled, null, { timeout: 30000 });
  await page.click("#o-run");
  await page.waitForFunction(() => document.querySelector("#o-result table") !== null
    || document.getElementById("o-status").textContent.startsWith("Could not"), null, { timeout: 300000 });
  const status = await page.textContent("#o-status");
  check(!status.startsWith("Could not"), `optimizer runs${status.startsWith("Could not") ? ": " + status : ""}`);
  const verdict = await page.textContent("#o-result .verdict");
  check(/Best of the candidates|No best layout/.test(verdict), `optimizer gives a verdict: "${verdict}"`);
  const rows = await page.$$eval("#o-result table", (ts) => ts.map((t) => t.querySelectorAll("tbody tr").length));
  check(rows.length === 2 && rows[0] > 0 && rows[1] > 0, `ranking and naive comparison tables have rows (${rows.join(", ")})`);
  const judged = await page.textContent("#o-result .hint");
  check(judged.includes("not measured") && judged.includes("not a proven optimum"), "results are labelled simulated, not proven");
  check(!(await page.getAttribute("#o-export-report", "disabled")), "optimizer report export is enabled");
  check(!(await page.getAttribute("#o-export-ranking", "disabled")), "ranking CSV export is enabled");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 0) {
    const who = await page.evaluate(() => { const W = document.documentElement.clientWidth;
      return [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > W + 1).slice(0, 8)
        .map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}.${String(e.className?.baseVal ?? e.className).split(" ")[0]} right=${Math.round(e.getBoundingClientRect().right)}`); });
    console.log("  offenders at 390 px:\n    " + who.join("\n    "));
  }
  check(overflow <= 0, `no horizontal page scroll at 390 px (overflow ${overflow} px)`);

  check(errors.length === 0, `no console or page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
} catch (err) {
  failures.push(String(err.message ?? err));
  console.log("FAIL ", err.message ?? err);
} finally {
  if (browser) await browser.close();
  server.kill();
}
console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nAll planner browser checks passed.");
process.exit(failures.length ? 1 : 0);
