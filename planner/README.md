# planner/ (Workstream D, parts D1 to D6: foundation, geometry, blueprint upload, coverage search, crowd-aware planning, anchor placement optimizer)

Owner: Member D. Contract version: 1.0. No runtime dependencies. Needs Node 20+.

## Commands (from a clean checkout)
```
cd planner
make setup      # checks Node version
make test       # 105 tests
make coverage RANGE=15   # coverage search from fixtures/sample_plan.json (PLAN=... to change); RANGE has no default
node tools/coverage_sweep.js   # result vs range and vs budget
make crowd RANGE=15 FALLBACK=2   # with/without crowd zones; FALLBACK = density for crowd zones that have none
make optimize RANGE=15 FALLBACK=2   # D6: ranked layouts, median/P90 simulated error, naive grid comparison
make plan       # serves the repo root; open http://localhost:8080/planner/
make sample     # regenerates fixtures/sample_blueprint.png and sample_plan.json
make bench      # timing of grid + visibility (re-runnable, machine dependent)
make analytics  # D8: regenerates the seeded placeholder analytics stand-in for the demo panels (not results)
make fixtures   # regenerates the stand-in replay from seed 4242 (+ manifest)
```

## What is here
| Path | Purpose |
|---|---|
| `src/core/constants.js` | Frozen contract numbers (dt, 8 slots, 3 usable anchors, zone types, run_id pattern) |
| `src/core/transforms.js` | Metres <-> canvas pixels, fit-to-canvas, blueprint scale calibration, image px <-> metres |
| `src/core/geometry.js` | Segment intersection, line of sight, point-in-polygon, area, metric grid, per-anchor visibility (policies P1 to P6) |
| `src/plan/plan_model.js` | Immutable plan state (image-pixel geometry), reducer, undo/redo history |
| `src/plan/editor.js` | Tool state machine: scale, boundary, walls, obstacles, zones, crowd circle, drafting, finish/cancel |
| `src/plan/plan_validate.js` | Errors (block export) and warnings (recorded in plan.json) in plain words |
| `src/plan/plan_export.js` | `plan.json` sidecar, `venue.json` (contract 9.1), plan reload, circle polygon |
| `src/plan/image_check.js` | PNG/JPEG upload checks on real bytes, size and dimensions |
| `src/plan/coverage.js` | Coverage problem (grid, candidates, visibility), layout evaluation, lower bound, naive grid, venue-with-anchors |
| `src/plan/search.js` | Minimum-anchor search: lower bound, greedy + pruning, ascending seeded local search, honest labels |
| `src/plan/coverage_report.js` | Report JSON with assumptions, warnings and manifest; anchors.csv |
| `src/plan/crowd.js` | Crowd model (range loss and extra anchors vs density), density raster, hooks into the coverage problem |
| `src/plan/crowd_compare.js` | Same plan with and without crowd zones: three searches, region statistics, report JSON and two CSVs |
| `src/plan/hash.js` | SHA-256 and canonical JSON for config hashes |
| `src/plan/viewport.js` | Image px <-> screen px, fit, zoom, pan (display only) |
| `src/ui/app.js`, `index.html`, `src/ui/planner.css` | Browser page; forwards events to the editor |
| `src/core/rng.js` | Seeded random generator shared by tools and tests |
| `src/core/validate.js` | Client-side checks for venue (9.1) and predictor output (9.3) |
| `src/adapters/inference_adapter.js` | `buildModelInput`, mock predictor, `createPredictor` swap point, out-of-bounds flag |
| `src/adapters/scenario_adapter.js` | Venue and replay loaders with validation |
| `src/adapters/analytics_adapter.js` | Normalises C's analytics; missing data becomes "not yet generated" |
| `src/adapters/simulator_adapter.js` | D6 **stand-in** for A's simulator: seeded walks (truth), readings per layout with common random numbers, separate labels |
| `src/plan/optimizer.js` | D6: candidate layouts, slot policy, simulated median/P90 scoring, ranking, Pareto front, naive comparison |
| `src/plan/optimizer_report.js` | D6 report JSON with manifest, ranking CSV, anchor CSV |
| `tools/run_optimizer.js` | Command-line optimizer from a plan.json |
| `fixtures/` | Stand-in venue, seeded stand-in replay and its manifest; `sample_crowd.*` is the saved crowd comparison of the sample plan (range 15 m, fallback density 2) |
| `tools/make_sample_replay.js` | Temporary seeded generator (section 8 equations, minimal form; blocking via `geometry.js`) |
| `tools/make_sample_blueprint.js` | Draws the sample floor plan PNG (20 px/m, 10.0 m scale bar) and traces `sample_plan.json` through the real editor and exporter |
| `tools/run_crowd.js` | Command-line crowd comparison; writes `.report.json`, `.regions.csv`, `.anchors.csv` |
| `tools/run_coverage.js`, `tools/coverage_sweep.js` | Command-line coverage search and sensitivity sweep |
| `tools/bench_geometry.js` | Seeded timing script for grid and visibility |
| `schemas/STAND_IN_FORMATS.md` | Formats D assumed where the guide is silent, with who to ask |

## Using the blueprint planner
1. `make plan`, open `http://localhost:8080/planner/` in Chrome or Edge.
2. Choose `fixtures/sample_blueprint.png`. Set scale: click the two ends of the scale bar (bottom left) and enter 10.
3. Trace the floor boundary, walls, obstacles and zones. Finish each shape with the button, F or a double-click.
4. Fix anything under Checks, then export `plan.json` and `venue.json`. Both are saved locally; nothing is uploaded.
5. Under Coverage and anchors, enter the assumed range (required, no default) and press Find minimum anchors. The plan shows covered cells, red hatching where fewer than 3 anchors reach, the anchors and the weakest point.
To skip tracing, load `fixtures/sample_plan.json` onto the sample image with "Load a saved plan.json".

## How the coverage search works
- **Criterion (contract v1):** every walkable grid cell centre has at least 3 anchors within the assumed range and with clear line of sight past every traced wall and obstacle.
- **Lower bound:** max(required anchors per cell, ceil(total required coverage / most cells any one candidate can serve)). Valid for the candidate set tested.
- **Search:** a greedy layout, pruned of redundant anchors, gives a guaranteed result of size U. Then for k = lower bound up to U-1 a seeded local search tries to find a k-anchor layout; the first k that succeeds wins.
- **Labels:** k equal to the lower bound reads "Minimum for this candidate set, grid and range (proven)". Anything else reads "Best found within search budget (not proven minimal)". A layout that misses the criterion reads "Coverage criterion not met" with the reason.
- **Budget** is counted in evaluations (one candidate placement scored or one swap tried), including the greedy phase, so results depend only on inputs and seed. The naive-grid comparison is not counted.

Measured on the 50 x 30 m sample plan (`node tools/coverage_sweep.js`, seed 1, 1 m grid, 2 m candidate spacing, 1480 cells, 350 candidates, budget 20,000):

| Assumed range | Anchors found | Lower bound | Greedy | Naive grid needs |
|---|---|---|---|---|
| 10 m | 29 | 15 | 32 | more than 40 |
| 15 m | 18 | 8 | 21 | 22 |
| 20 m | 12 | 6 | 14 | 17 |
| 25 m | 11 | 6 | 13 | 16 |

At 15 m, raising the budget from 20,000 to 400,000 left the answer at 18, and a budget of 5,000 was too small to build a layout (reported as not met, reason budget). The gap between lower bound and found size is large because the bound is loose; it is not evidence that fewer anchors would work. Each run took about 0.4 to 0.6 s on the build machine (Node 22), including setup.

## Crowd-aware planning (D5)
Draw crowd circles or crowd zones with a density (0 to 4 people per m2), then use **Crowd-aware planning** in the side panel, or `make crowd`. The planner runs the minimum-anchor search twice on the same plan, grid, candidates and seed: once with the crowd zones removed and once under the crowd model. A third search with seed + 1 shows how much the answer moves from search variation alone.

**Crowd model (planning assumptions, shown in every report):**
- Usable range along an anchor-to-cell path = assumed range x max(0.5, 1 - 0.1 x mean density on that path).
- Usable anchors needed at a cell = 3 + min(2, ceil(density at the cell / 2)); no extra where density is 0.
- Overlapping zones take the higher density. A crowd zone without a density needs the "density for zones that have none" value; there is no default.

**What the comparison reports** (all judged against the same crowd-aware requirement): anchors with and without crowd zones, uncovered fraction and mean usable anchors inside crowd, outside crowd and per zone, a naive grid with the same count as the crowd-aware layout, anchors kept/added/removed, and the seed-control result. On the sample plan (range 15 m, 1 m grid, seed 1, budget 20,000 per search, `make crowd RANGE=15 FALLBACK=<d>`):

| Crowd density | Anchors ignoring crowds | Crowd-aware | Ignoring-crowds layout, uncovered inside crowd | Crowd-aware, uncovered inside crowd |
|---|---|---|---|---|
| 1 per m2 | 18 | 19 | 37.5% | 0% |
| 2 per m2 | 18 | 19 | 40.0% | 0% |
| 4 per m2 | 18 | 20 | 100% | 0% |

At 1 and 2 people per m2 the +1 anchor equals the difference between the two seeds of the ignoring-crowds search (18 vs 19), so the report says it cannot be told apart from search noise. At 4 per m2 the +2 is larger than that variation. The crowd zone there is 80 cells; the crowd-aware layout is better inside it largely **by construction**, because it is searched against the stricter requirement.

**What this does not show:** positioning error. Median and P90 error inside crowd zones need A's simulator. D6 supplies them (see the D6 section); the D5 report itself still marks them "not yet generated". Positions of kept/added/removed anchors mostly reflect search variation (two seeds share only 2 to 3 anchors), so read the counts and the region table, not the individual positions.

## Anchor placement optimizer (D6)
Run `make optimize RANGE=15 FALLBACK=2` (or `node tools/run_optimizer.js fixtures/sample_plan.json --range 15 --fallback-density 2`). It writes a report JSON, a ranking CSV and a CSV of the best layout's anchors. Samples are in `fixtures/sample_optimizer.*`.

**Pipeline:** candidate layouts (D4 searches with three seeds, a no-crowd search, redundancy extensions, naive grids) → coverage check against the crowd-aware requirement → seeded walks with simulated readings (stand-in simulator) → mock predictor → median and P90 error, overall and inside / outside crowd zones → ranking of layouts that meet the criterion, Pareto front, and a naive-grid comparison at each anchor count.

**Objective:** `P90 + anchor_cost_m x anchors`, with the cost defaulting to 0, so the ranking is by P90 alone. The Pareto front shows what extra anchors buy.

**Measured on the sample plan** (crowd density 2 for the zone without one, seed 1, 3 walks of 180 s, mock predictor, stand-in simulator; these are not Traceline results):

| Range | Best layout | Anchors | P90 | Smallest layout found that meets the criterion | Best that fits 8 slots |
|---|---|---|---|---|---|
| 15 m | L06 | 21 | 1.36 m | 19 | none |
| 20 m | L08 | 15 | 1.55 m | 13 | none |
| 25 m | L08 | 14 | 1.45 m | 11 | none |

**Robustness check, 15 m, four evaluation seeds** (same blueprint, only the walks and noise change):

| Seed | Best layout (anchors) | Best P90 | Optimised P90 at 20 anchors | Naive grid P90 at 20 anchors |
|---|---|---|---|---|
| 1 | L06 (21) | 1.36 m | 1.37 m | 1.29 m |
| 2 | L06 (22) | 1.43 m | 1.44 m | 1.51 m |
| 3 | L02 (19) | 1.49 m | 1.51 m | 1.40 m |
| 4 | L12 (20) | 1.30 m | 1.30 m | 1.71 m |

**What these numbers say, and what they do not:**
- **The optimizer does not reliably beat the naive grid on simulated error.** At 20 anchors the optimized layout is better in two seeds and worse in two. The naive grid at that size misses the coverage criterion in every seed, so the comparison is between a layout that meets the criterion and one that does not. Treat the simulated advantage as unproven. DECISIONS 66.
- **Beyond 8 anchors, error barely moves** with this mock predictor, because only 8 slots reach it at each step. The layouts from 19 to 22 anchors all land between about 1.3 and 1.5 m.
- **Inside crowd zones** (15 m, seed 1): the best layout has P90 1.60 m against 1.35 m outside. The no-crowd search's 18-anchor layout does worse inside crowds (2.21 m) than the crowd-aware 19-anchor layout (1.62 m). Those figures rest on 90 simulated steps and on placeholder crowd effects, so they are indicative only.
- **Coverage is a geometry result.** The criterion is met by construction for ranked layouts. The simulated error is the only new evidence, and it depends on the stand-in simulator and the mock predictor.

## Swapping stand-ins for real outputs (file swaps only)
- **Model:** pass B's factory to `createPredictor({ real })`. UI code does not change.
- **Venue / replay:** point the loaders at A's `shared/venues/*.json` and replay fixtures; map shape differences inside `scenario_adapter.js`.
- **Analytics:** drop C's JSON where `loadAnalytics` points; sections default to "not yet generated".
- **Simulator (D6):** replace `src/adapters/simulator_adapter.js` with A's `sim/js` keeping the same outputs (walks with truth; readings per layout). Replace `STAND_IN_SIGNAL` and `STAND_IN_CROWD_EFFECTS` with the numbers in `shared/signal_model.json`.

## Limits to know
- **Coverage here is a simulation of geometry.** It uses your assumed range, your traced walls and a grid sampled at cell centres. It does not predict real radio behaviour. Every report carries a site-survey warning.
- **Crowd coefficients are not the simulator's.** They are D's assumptions until A's `signal_model.json` crowd formula can be mirrored. Crowd results are geometric and conditional on them.
- **More than 8 anchors cannot go into a venue file.** The model takes at most 8 anchor slots. At the ranges tried on the sample plan the answer was 11 to 29 anchors, so the export-with-anchors button is disabled for such layouts. See DECISIONS item 39.
- **The planner page has not been run in a real browser yet.** All its logic is unit-tested in Node. For D5 the page was loaded under a DOM simulator (jsdom, not committed) and all 58 element IDs resolve, but drawing, pointer and keyboard handling and the new crowd buttons are untested in Chrome or Edge. Try it first and report problems.
- Mouse and keyboard only; panning on touch screens is not supported. Target: current Chrome or Edge on desktop.
- Scale comes from one marked distance; its accuracy limits every metric result. Walls are fully blocking in version 1 and the material label is only recorded.
- The mock predictor is plain least-squares trilateration. Its sigma and NLOS values are crude and uncalibrated. `confidence` is `null` on purpose.
- The stand-in replay is simulated, has no crowd/drift/spike effects, and about 63% of its readings are NLOS because the route passes behind interior walls and a shelf. Treat it as a UI fixture, not as a benchmark.
- Geometry results are approximations at the chosen grid resolution (cell centres are tested, not whole cells). Visibility is geometric only and says nothing about real radio behaviour through walls.
- Measured on this build machine (Node 22, 100 x 60 m, 60 walls, one anchor): 17 ms at 1 m, 9 ms at 0.5 m, 27 ms at 0.25 m resolution (96,000 cells). Re-run `make bench`; D4 will multiply this by candidate count, so cache per-anchor visibility there.
