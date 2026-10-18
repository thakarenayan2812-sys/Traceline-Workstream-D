// D8 browser check (optional; needs the Playwright package and a Chromium it can launch).
// Starts the static server itself, then checks in a real browser:
//   - no console or page errors, and no request to any host other than localhost (offline rule)
//   - keyboard: Space on the Play button toggles once; Space on the map toggles; Home/End; arrows
//   - reduced-motion switch sets the body class
//   - no horizontal page scroll at 390 px (phone) and 1280 px (desktop)
//   - the analytics panels render their stand-in labels and the "Not yet generated" text when data is absent
// Usage: node tools/browser_check.mjs   (env PLAYWRIGHT_PATH to point at the playwright package if it is not installed locally)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const PORT = Number(process.env.PORT ?? 8093);
const BASE = `http://localhost:${PORT}/demo/`;

async function loadPlaywright() {
  const req = createRequire(import.meta.url);
  const target = process.env.PLAYWRIGHT_PATH ?? "playwright";
  try { return req(target); } catch { /* try as an ESM path below */ }
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
  const errors = [], hosts = new Set();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => hosts.add(new URL(r.url()).host));

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.getElementById("predictor-badge").textContent.startsWith("Predictor"));

  // Offline rule: after load, abort anything that is not this server, and record it.
  await page.route("**/*", (route) => {
    const host = new URL(route.request().url()).host;
    hosts.add(host);
    return host.startsWith("localhost") ? route.continue() : route.abort();
  });

  const playLabel = () => page.textContent("#play");
  const stepText = () => page.textContent("#step-label");
  const pressed = () => page.getAttribute("#play", "aria-pressed");

  // Space on the focused Play button: exactly one toggle (the button's own click), not two.
  // The button's own click runs on key-up, so wait for the state to settle before reading it.
  await page.focus("#play");
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  check((await pressed()) === "true" && (await playLabel()) === "Pause", "Space on Play starts playback");
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  check((await pressed()) === "false" && (await playLabel()) === "Play", "Space on Play pauses playback");

  // Space on Step must step once and must not start playback (D1-D7 started playback here).
  await page.focus("#step-fwd");
  await page.keyboard.press("Space");
  await page.waitForTimeout(150);
  check((await playLabel()) === "Play" && (await stepText()).startsWith("Step 2 of 120"), "Space on Step steps once and does not start playback");
  await page.focus("#map");

  // Space on the map canvas toggles playback.
  await page.focus("#map");
  await page.keyboard.press("Space");
  check((await playLabel()) === "Pause", "Space on the map starts playback");
  await page.keyboard.press("Space");
  check((await playLabel()) === "Play", "Space on the map pauses playback");

  await page.focus("#map");
  await page.keyboard.press("End");
  check((await stepText()).startsWith("Step 120 of 120"), "End goes to the last step");
  await page.keyboard.press("Home");
  check((await stepText()).startsWith("Step 1 of 120"), "Home goes to the first step");
  await page.keyboard.press("ArrowRight");
  check((await stepText()).startsWith("Step 2 of 120"), "ArrowRight steps forward");
  await page.keyboard.press("ArrowLeft");
  check((await stepText()).startsWith("Step 1 of 120"), "ArrowLeft steps back");

  // Arrow keys on a focused slider belong to the slider.
  await page.focus("#anchors");
  const before = await page.inputValue("#anchors");
  await page.keyboard.press("ArrowLeft");
  check((await page.inputValue("#anchors")) !== before, "ArrowLeft on the anchors slider changes the slider, not the replay");
  await page.fill("#anchors", "6");
  await page.dispatchEvent("#anchors", "change");

  // Reduced motion switch.
  await page.check("#reduce-motion");
  check(await page.evaluate(() => document.body.classList.contains("reduce-motion")), "Reduce motion switch sets the body class");
  await page.uncheck("#reduce-motion");

  // Analytics panels: stand-in labels present, no numbers invented for missing sections.
  const badges = await page.$$eval("#analytics-panels .an-badge", (els) => els.map((e) => e.textContent));
  check(badges.length === 4 && badges.every((b) => b.startsWith("Stand-in values")), "all four analytics panels say they are stand-in values");
  check((await page.textContent("#analytics-summary")).includes("4 stand-in"), "analytics summary line counts the stand-ins");
  check((await page.textContent("#status")).includes("Analytics panels"), "system status lists the analytics panels");

  // No horizontal page scroll at desktop and phone widths.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(overflow <= 0, `no horizontal page scroll at ${width} px (overflow ${overflow} px)`);
  }

  check(errors.length === 0, `no console or page errors${errors.length ? ": " + errors.join(" | ") : ""}`);
  const remote = [...hosts].filter((h) => !h.startsWith("localhost") && !h.startsWith("127.0.0.1"));
  check(remote.length === 0, `no request left the machine${remote.length ? ": " + remote.join(", ") : ""}`);
} catch (err) {
  failures.push(String(err.message ?? err));
  console.log("FAIL ", err.message ?? err);
} finally {
  if (browser) await browser.close();
  server.kill();
}

console.log(failures.length ? `\n${failures.length} check(s) failed.` : "\nAll browser checks passed.");
process.exit(failures.length ? 1 : 0);
