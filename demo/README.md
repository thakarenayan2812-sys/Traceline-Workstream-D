# demo/ (Workstream D, parts D1, D7 and D8: shell, live dashboard, analytics panels and hardening)

```
cd demo
make demo          # serves the repo root; open http://localhost:8080/demo/
make test          # planner tests, then demo tests (no browser needed): 105 + 49
make browser-check # optional: real Chromium check (needs the Playwright package; PLAYWRIGHT_PATH if not installed)
```
Needs Python 3 for the static server only. No backend, no API, no network use after the page loads. Chrome or Edge on desktop.

## What the dashboard does
- **Replay (D7):** the stand-in venue (walls, zones, obstacle, 6 anchors) and the recorded 120-step replay. Play, pause, step, reset, scrub and speed (0.25x to 4x).
- **Scenario controls (D7):** active anchors (3 to 6), range noise (1x to 3x), extra dropout (0 to 50%), obstruction bias (0 to 200% of the recorded bias), crowd density (0 to 4 people per m2 in crowd zones). They change the readings, and changed readings are labelled.
- **Map layers (D7):** walkable area, zones (crowd dotted, restricted dashed), obstacles, walls, anchors (filled when active, hollow when off, ringed and tagged "obstructed?" when suspected), trail, ground truth (ring), 1-sigma uncertainty (dashed), estimate (filled), forecast +0.5 to +2 s (dotted). Each layer has its own shape or line style.
- **Diagnostics (D7):** estimate in metres, uncertainty, valid anchors, suspected obstructed anchors, forecast horizon, error against truth, reason text and a warning level. The warning text is announced when its level changes.
- **Error so far (D7):** median and P90 over the played steps for the predictor, B1 and B2. B3 says "not yet generated".
- **Emergency tracking view (D7):** a warning frame, a note with the count of flagged steps, and a statement that it is a prioritisation view, not a clinical or safety system.
- **Anchor placement (saved sample run):** the optimizer's ranked layouts and naive-grid comparison from `sample_optimizer.report.json`. Labelled as a saved sample run from the sample plan, not your uploaded plan.
- **Analytics from Workstream C (D8):** four panels read from C's JSON: error map before and after self-learning, crowd degradation, automatic stress test, emergency flags. Each panel shows where its numbers come from. Sections with no output say "Not yet generated" and show no numbers. Layouts are listed in `planner/schemas/STAND_IN_FORMATS.md`.

## Keyboard and access (D8)
| Key | Action |
|---|---|
| Space | Play or pause the replay |
| Left, Right arrows | Previous or next step |
| Home, End | First or last step |

The replay keys work when the focus is on the map or the page. A focused button, slider, select or checkbox keeps its own keys, so Space on Step steps once and does not start playback. (In D1 to D7, Space on Step started playback instead; fixed in D8.)

- Visible focus ring on every control (`:focus-visible`). A skip link goes to the map.
- **Reduce motion:** a switch in the controls. It starts from the system setting and follows it when that changes. It removes the map trail fade. Playback has no easing animation, so nothing else moves on its own.
- Wide analytics tables sit in a keyboard-focusable scroll region. Warnings carry the word "Warning" and bold text, not colour alone.
- Phone width (390 px): one column, no page scroll, analytics labels stacked above values.

## Measured behaviour (stand-in replay, default controls, mock predictor)
These are stand-in numbers from a recorded replay, not Traceline results. Unchanged from D7; the D8 changes do not touch the predictor or the controls.

| Controls | Predictor median / P90 | B1 median / P90 | B2 median / P90 | Outside-venue steps |
|---|---|---|---|---|
| Default | 1.64 m / 2.49 m | 1.41 m / 2.51 m | 1.63 m / 4.10 m | 0 |
| Obstruction removed | 0.34 m / 0.58 m | 0.30 m / 0.52 m | 0.31 m / 0.55 m | 0 |
| +30% dropout | 1.96 m / 4.20 m | 1.79 m / 6.44 m | 1.84 m / 13.93 m | 5 |
| Noise 2x | 1.69 m / 2.94 m | 1.51 m / 2.76 m | 1.59 m / 3.65 m | 3 |

Obstruction bias dominates the error in this replay, and the residual-rejection baseline becomes unstable when dropout leaves few anchors. Both are reported, not tuned away.

## Tests and checks (D8)
- `make test`: 105 planner tests and 45 demo tests. The demo tests cover the engine (D7), the analytics view models and their honesty rules, the keyboard rules, and integration: every id the script uses exists in the page, every ARIA reference and local file resolves, the predictor never receives truth fields, a run is repeatable, the stand-in matches its seed and manifest hash, and no shipped file contacts a remote host (offline rule).
- `make browser-check`: headless Chromium, with the server started by the script. It checks keyboard behaviour (including Space on Step), the reduce-motion switch, the analytics labels, no horizontal scroll at 1280 px and 390 px, no console errors, and that no request leaves localhost. Last run: all 18 checks passed.
- Still to do by a person: a check in Chrome or Edge on a real desktop, and on a real phone. The browser check above is headless Chromium only.

## Not yet built
- Blueprint upload and planner (D3 to D5, in `planner/`). Optimizer panel (not on the D7 or D8 list).
- B3 Kalman number (B's output). Real predictor (B's `infer.js`). A's simulator and replays. C's real analytics JSON. These arrive through the adapters only.

## Files
| Path | Purpose |
|---|---|
| `index.html`, `src/style.css` | Page structure and styles (colour tokens follow the system theme) |
| `src/main.js` | Wiring: controls, playback loop, keyboard, reduce motion, diagnostics, panels, emergency view |
| `src/engine/controls.js` | Scenario controls applied to the recorded replay |
| `src/engine/playback.js` | Playback state (pure) |
| `src/engine/access.js` | Keyboard rules: which keys act for which focus, key to action (pure) |
| `src/engine/scenario_runner.js` | Runs the predictor and baselines step by step, measurements only |
| `src/engine/baselines.js`, `noise_model.js` | B1 and B2 demo stand-ins |
| `src/engine/diagnostics.js` | Warning levels and suspected obstructed anchors |
| `src/panels/analytics_view.js` | C's JSON to panel view models: validation and honesty rules (pure) |
| `src/panels/analytics_panels.js` | Draws the view models into the page (text only) |
| `src/render/map.js` | Layered canvas drawing |
| `tools/browser_check.mjs` | Optional headless-browser check |
| `tests/engine.test.js` | D7 engine tests |
| `src/panels/optimizer_view.js` | The saved optimizer run as a panel |
| `tests/analytics_view.test.js`, `tests/access.test.js`, `tests/integration.test.js`, `tests/optimizer_view.test.js` | D8 tests |

## Swapping stand-ins for real outputs (file swaps only)
- **Predictor:** the page calls the inference adapter; B's `infer.js` replaces the mock through `createPredictor`.
- **Replay and venue:** point the loaders at A's scenario JSON. Controls keep working on any replay with the same shape.
- **Baselines:** replace `src/engine/baselines.js` with B's B1/B2 (same inputs) and add B3 when it exists.
- **Analytics:** replace `planner/fixtures/analytics.stand_in.json` with C's output (same file name, same layouts). The panels then say "From C's output" with no code change. If C's layouts differ, change the view builder and record it in DECISIONS.
