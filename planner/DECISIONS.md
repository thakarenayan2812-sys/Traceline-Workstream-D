# DECISIONS (Workstream D, planner/)

Each entry is a choice the guide did not cover. Items marked **raise** need team confirmation.

1. **No build tooling, no dependencies.** Plain ES modules and Node's built-in test runner. Keeps clean-laptop reproduction trivial and avoids the "tell the team before adding a dependency" rule.
2. **`demo/` imports from `../planner/src/`.** Both folders are D's. `make demo` serves the repo root so the paths resolve. Opening `index.html` as a file will not work (browsers block module imports from file://); the page shows an explanatory error.
3. **Mock predictor is real trilateration, not canned values.** Honest with the "no hard-coded answers" rule. Its sigma is the RMS range residual (floor 0.3 m); NLOS probability is a logistic of each anchor's residual. Both are labelled mock and uncalibrated in the UI. **raise (B):** confirm the input and output shapes in `schemas/STAND_IN_FORMATS.md`.
4. **`confidence` is `null` in the mock.** Guide 10.2 forbids calling a score confidence without a tested meaning.
5. **Raw model input uses `null` plus `valid_flag: 0` for missing values.** Neutral normalised values are B's job inside `infer.js`. **raise (B).**
6. **Replay stand-in format and `run_id: null`.** The guide requires unique `run_id`s across datasets, so a hand-made stand-in must not claim one. **raise (A):** map A's replay fixtures into this shape or tell D the real shape.
7. **Analytics shape: `{section: {status, data}}`** with statuses `ok`, `stand_in`, `not_yet_generated`. Per-section `data` layouts are deferred to D8. **raise (C).**
8. **Stand-in generator copies the section 8 numbers** because `shared/signal_model.json` is not available to D yet. Must be replaced by reading that file once it exists.
9. **Out-of-bounds estimates are flagged with reason code `OUT_OF_BOUNDS`, never clamped** (guide 10.3).
10. **System fonts only, no CDN.** The demo must work offline (guide 3).
11. **Test command is `node --test` without a path.** Passing a directory fails on Node 22 and the bare form discovers `*.test.js` on 20 and 22.
12. **Stand-in replay is NLOS-heavy (63.1% of readings after D2).** Not tuned; a side effect of the route, interior walls and the shelf. Left as is and disclosed in the README.

## D2 geometry policies
The guide asks for tested handling of touching endpoints and near-parallel segments but does not say what the answers should be. These are D's choices. **raise (A):** A's `sim/js` must use the same policies or the optimizer will disagree with the simulator about which anchors are blocked.

13. **P1 Tolerance 1e-6 m.** Contacts closer than this count as touching.
14. **P2 Parallel threshold: sine of angle below 1e-9.** Parallel segments intersect only if within tolerance of the same line.
15. **P3 Endpoint contact does not block.** An anchor mounted on a wall, or a target standing at a wall, still has line of sight from that point. Consequence: an anchor on a wall face sees both rooms.
16. **P4 Touching a wall or polygon vertex elsewhere blocks.** Conservative: a path exactly through a wall end counts as blocked.
17. **P5 Running along a wall or edge blocks.**
18. **P6 Obstacles are solid.** Blocked if either end or the midpoint is strictly inside, or any edge blocks. The midpoint test catches corner-to-corner paths that cross no edge.
19. **Grid cells are tested at their centre.** Cell (i, j) is walkable if its centre is inside the venue and boundary and not strictly inside an obstacle. Grid size is capped at 2,000,000 cells with a clear error.
20. **`rng.js` moved into `src/core`** so tools and tests share one seeded generator.

## D3 blueprint planner choices
21. **Geometry is stored in image pixels and converted to metres only at export** (guide 7: convert back before saving). Exported positions use 3 decimals.
22. **Origin = bottom-left of the bounding box of ALL traced geometry** (boundary, walls, obstacles, zones), not only the boundary. Exterior walls sit just outside the floor outline, and this keeps every coordinate non-negative.
23. **Custom venue export.** `venue_id` is `"custom"` (the guide's list has only the four dataset venues) and the walkable boundary is stored in `metadata.walkable_boundary_m` because contract 9.1 has no top-level key for it. **raise (all):** confirm, or propose a schema change.
24. **`planner_settings` fields are `null` until D4** (max range, grid resolution, search budget, mounting constraints). No invented defaults. `required_usable_anchors` is 3 (contract v1).
25. **Warning thresholds are D's choices:** scale baseline whose one-pixel error exceeds 2%, baseline under 10% of the image, under 5 px per metre, traced area under 2 m or over 500 m on a side, and no walls traced at all. Errors block export; warnings are written into `plan.json`.
26. **Upload limits:** PNG or JPEG judged by file bytes, at most 20 MB, 200 to 12,000 px per side.
27. **Crowd circle is stored as a 32-sided polygon** with `shape: "circle"` and an optional density (0 to 4 people per m2). How D5 uses the density is not decided yet. **raise (C, for consistency with crowd analysis).**
28. **Wall material is recorded only.** Version 1 treats every wall as fully blocking.
29. **History keeps whole-state snapshots (cap 200).** Unfinished drawings are not in history; Backspace and Escape handle those. Reset is undoable.
30. **Keyboard alternative:** a crosshair moved with the arrow keys and placed with Enter, so every action is possible without a mouse (guide 11).
31. **Sample files are generated, not hand-made.** `make sample` draws the PNG and traces the plan through the real editor and exporter; `created_at` is a fixed constant so the output is byte-stable.

## D4 coverage and minimum-anchor search
32. **Coverage = at least 3 anchors per walkable cell centre, in range, with line of sight** (contract v1). A per-cell requirement hook exists for D5's crowd penalty; with no hook every cell needs 3.
33. **Candidate positions:** either a floor lattice (offset half a spacing so points avoid walls and edges) or "wall-mounted" points on both sides of every wall and boundary edge. Every candidate keeps at least 0.2 m from any wall. This is a deliberate guard against D2 policy P3, under which an anchor exactly on a wall would see both rooms.
34. **Lower bound** = max(per-cell requirement, ceil(total required coverage / most cells one candidate serves)). It is valid but loose. "Proven" means k equals this bound, and only for the candidate set, grid and range used.
35. **Algorithm:** greedy (first-best on ties), pruning of redundant anchors, then ascending seeded local search with swap moves aimed at uncovered cells and restarts that perturb the best layout. Chosen so the search starts at the lower bound and increases k, as the guide describes, while still guaranteeing a fallback layout.
36. **Budget is evaluations, not seconds,** and includes the greedy phase. If it runs out before a full layout exists, the result is "not met, reason budget" and the partial layout is shown as such, never as a success.
37. **UI defaults:** resolution 1 m, candidate spacing 2 m, budget 20,000, max anchors 40, seed 1. These are computation settings the user can change. **Maximum range has no default**: it is a physical assumption the user must supply.
38. **Worst-case point** = the cell with the smallest (usable anchors minus required), first in row order on ties. It is reported even when the whole area is covered, so it shows the tightest spot.
39. **Layouts above 8 anchors cannot be exported into a venue** (contract 9.3 allows at most 8 slots). On the sample plan the searched ranges needed 11 to 29 anchors. **raise (B and all):** either the model should pick the 8 nearest or most informative anchors from a larger layout (inference would then need an anchor-selection step), or the planner should report coverage per 8-anchor cluster. Until decided, D shows the layout and a warning but refuses the venue export.
40. **Report manifest:** seed, config hash (SHA-256 of canonical JSON), runtime, timestamp; `git_commit` is null in the browser and filled by the command-line tool. The command-line tool uses the plan's own timestamp so the saved example report is reproducible.
41. **Saved example:** `fixtures/sample_coverage.*` was generated with `--range 15`. The 15 m is an example assumption, stated in the report, not a claim about any hardware.

## D5 crowd-aware planning
42. **Two mechanisms, both monotonic in density.** Range along a path shrinks with the mean density on the path (path mean sampled about once per grid cell); the usable-anchor requirement at a cell rises with the density at that cell. This follows the guide's "crowd path density" wording and its statement that crowds raise noise, blocking and loss together. **raise (A, C):** coefficients (0.1 range loss per person per m2, floor 0.5, +1 anchor per 2 people per m2, cap +2) are D's placeholders; replace them with the formula in `shared/signal_model.json` when A publishes it. Any change is a model-object change, not a code change.
43. **Densities travel in `venue.metadata.zone_density_people_m2`** ({zone_id: density}, crowd zones only) because contract 9.1 zones have no density field. `plan.json` already stores it per zone. **raise (all):** confirm, or propose a schema change.
44. **No default density.** A crowd zone with no density stops the comparison until the user enters a density for it or a fallback value, in the same spirit as "no default range". The fallback is recorded per zone as `density_source: fallback`.
45. **"Without crowd zones" is literal:** the venue with crowd zones (and densities) removed, searched with the unchanged D4 code. A test shows a density-0 crowd gives a problem identical to D4's. Candidate positions, cells and seed are shared, so layouts are comparable index by index.
46. **Fair judging:** all layouts are scored against the crowd-aware requirement. The aware requirement implies the plain one (checked and reported as `meets_plain_criterion`). A naive grid with the same count as the aware layout is included as a fixed reference.
47. **Search-variation control.** Layout differences between two seeded searches are large (2 to 3 shared anchors), so the report repeats the unaware search with seed + 1 and states whether the extra anchors exceed the anchor-count spread between seeds. This guards against presenting search noise as a crowd effect. It is one extra seed, not a statistical test.
48. **Simulated error left explicitly "not yet generated".** The guide's evidence for feature 8 includes beating the no-crowd plan inside crowd zones "in simulation". That needs A's simulator and D6. D5 supplies the geometric part only and says so in the report and the page.
49. **Search budget applies per search** (three per comparison), so a comparison costs three times the budget. Stated on the page.
50. **Small edits to D3/D4 files, all backward compatible:** `coverage.js` accepts an optional `pair_range_factor` (absent = unchanged behaviour; tested); `toVenue` adds the density map to `metadata`. All 75 earlier tests still pass.

## D6 anchor placement optimizer (simulated error)
The guide asks for simulated median and P90 error from A's simulator, which is not available. D6 uses a stand-in and says so in every output.

51. **Stand-in simulator in `src/adapters/simulator_adapter.js`.** It copies the guide 8 starting values (not read from `shared/signal_model.json`, which is missing) and is the only file to replace when A's `sim/js` arrives. **raise (A):** confirm the numbers, the NLOS bias rule and the packet-loss rule, or supply the port.
52. **The predictor sees measurements only.** Truth and NLOS labels come back in separate objects, never in `buildModelInput`. Tests check every slot and feed field. **raise (B):** confirm the input contract is the one used here.
53. **Slot policy for more than 8 anchors:** the 8 valid readings with the smallest measured range (ties by anchor id), padded with unused anchors. Measured ranges only, so truth cannot leak. This is an assumption. **raise (A, B):** decide how a layout larger than 8 anchors feeds an 8-slot model. Same question as item 39.
54. **Common random numbers.** Noise is keyed by (seed, trajectory, step, candidate index). An anchor has the same noise in every layout that contains it, so differences between layouts come from geometry.
55. **Evaluation walks are a development set.** Seeded random walks at 1.0 m/s, 3 trajectories of 360 steps (180 s, the guide default), walk radius 15 m, never crossing a wall. They are never the hidden set (guide 11). **raise (A):** replace with A's replay scenarios when available.
56. **Candidate layouts.** D4 searches with seeds s, s+1 and s+2; a no-crowd search when crowd zones carry density; redundancy extensions of those layouts (one and two extra anchors, each chosen to give the most cells a spare anchor, ties by candidate index). A naive grid for each size is kept as a reference and is never ranked. The pool is finite, so the ranking is "best of these", not a global optimum.
57. **Crowd effects in the simulator are placeholders, and crowd zones always affect the simulated world.** Range noise is multiplied by (1 + 0.1 x density), packet loss rises by 0.02 per person/m2 (cap 0.5), and each reading gets a body-induced NLOS bias with chance 0.05 x density. All three are monotonic in density. Coverage judging follows D5 (crowd-aware when densities are given). **raise (A):** replace with the formula in `shared/signal_model.json`. Until then, simulated error inside crowd zones depends on these numbers.
58. **Objective = P90 + anchor_cost_m x anchors.** The default cost is 0, so the ranking is by P90 alone. Ties go to the lower median, then to fewer anchors. P90 is the main score because the guide stresses tail error; median, mean, RMSE and P95 are also reported. **raise (team):** choose a cost per anchor for the trade-off the customer cares about.
59. **Pareto front on (anchors, P90)** is listed next to the ranking, so trade-offs are visible rather than hidden inside the weighted objective.
60. **Percentiles use linear interpolation** between closest ranks.
61. **Best layout within 8 slots is reported separately.** The top-ranked layout often needs more than 8 anchors and cannot be exported, so the export-ready answer is shown too.
62. **Layouts that miss the criterion are simulated but not ranked.** Naive grids are simulated on the same walks and noise, for the comparison table only.
63. **Mock predictor is the default.** `runtime.predictor` (or B's factory through `createPredictor`) is the swap point. Numbers from the mock are not Traceline evidence.
64. **Small-sample warning.** The report warns when fewer than 200 simulated steps fall inside crowd zones.
65. **Simulator duplicates the section 8 numbers.** `tools/make_sample_replay.js` is left untouched so the committed replay fixture stays byte-identical. Two copies must be replaced together. **raise (A):** one source of truth.
66. **Finding, reported not tuned.** On the sample plan, the optimized layouts do not reliably beat the naive grid at equal anchor count across evaluation seeds (README). Changing the objective, the slot policy or the walk settings to make the optimizer look better was not done. **raise (team):** decide whether simulated comparisons should average several evaluation seeds before any claim is made.

Author: Member D (name to be filled in).

## Planner page: optimizer in the browser (fix after the D8 audit)
- The planner page now has an "Anchor placement optimizer" section that runs the same `runAnchorOptimizer` as `make optimize`, on the plan and settings on the page. It shows the ranked layouts and the naive-grid comparison, and exports `optimizer.report.json` and `optimizer.ranking.csv`. Results are labelled as simulated and as "best of these candidates", not as a proven optimum.
- The section needs a fallback crowd density for any crowd zone that has no density. The page says so in plain words and does not guess one.
- Browser check: `make browser-check` (needs Playwright; `PLAYWRIGHT_PATH` if it is not installed locally). It loads the sample plan, runs coverage and the optimizer, checks the outputs and exports, the phone width and the console.
- Phone width: result tables scroll inside their own region, and the drawing area can shrink below the canvas's natural width.
