# DECISIONS (Workstream D, demo/)

1. Shell only in D1: one canvas, one status panel, one step. Playback is D7.
2. Legend and map text alternative are provided for accessibility (guide 11). The canvas is focusable and has `aria-describedby` text with the estimate and truth.
3. Colour tokens follow `prefers-color-scheme`. Estimated (filled), truth (ring), forecast (dotted) and uncertainty (dashed) differ by shape and line style, not colour alone.
4. Errors are shown in an `role="alert"` paragraph with the fix (serve the repo root).

## D7 live demo dashboard
5. **Controls transform the recorded replay; they do not just relabel it.** Active anchors remove readings. Noise adds seeded extra noise so the total sigma is multiplied. Dropout adds seeded losses. Obstruction scales the recorded NLOS bias. Crowd density uses the stand-in crowd placeholders from the planner. Changed readings keep honest labels. Raise (A): the scenario should come from A's replay fixtures with these controls built in.
6. **Playback works on the recorded truth path.** The estimate, uncertainty and forecast are recomputed from the controlled readings through the inference adapter. Pause, play, step, reset, scrub and speed (0.25x to 4x) are in place. Keyboard: Space and arrow keys.
7. **Baselines B1 and B2 are demo stand-ins; B3 is not shown as a number.** B owns the real ones. B3 is labelled "Not yet generated" rather than invented. Raise (B): confirm B1/B2 are only a stand-in, and when B3 will arrive.
8. **Uncertain flag at 1.0 m sigma (demo threshold).** Not calibrated (guide 10.2). The label says so. Raise (B): the team needs a threshold from calibrated uncertainty before any flag is trusted.
9. **Emergency tracking view** prioritises the tracked target, flags uncertain or out-of-venue steps, and adds a warning frame that does not rely on colour. It is a visualisation, not a clinical or safety system (guide 11). Only one tracked asset exists in the stand-in replay, so there is no multi-asset prioritisation yet. Raise (A): multi-asset replays.
10. **Estimates are never clamped.** Out-of-venue estimates are flagged, and the marker is drawn at the canvas edge with a label only. The stored value is unchanged.
11. **Error columns use the truth and the running window only** (played steps). The predictor and the baselines never receive truth.
12. **Asset type control is not included.** A speed or asset change would need the simulator to re-run the motion, not just the readings. Deferred until A supplies the asset scenarios.
13. **Analytics panels** are still "not yet generated" (D8).
14. **Recorded fixture only.** One stand-in replay (120 steps, 60 s). The guide's 120 to 300 s range and the other scenario types arrive with A's replays.

## D8 analytics panels, keyboard, reduced motion, hardening
15. **Analytics panels show only what the file contains.** Each section is one of: from C's output, stand-in, incomplete (named missing fields), or not yet generated. No numbers are shown for the last two. Status is written as text and the stand-in label appears in every panel. Raise (C): confirm or change the layouts in `planner/schemas/STAND_IN_FORMATS.md`.
16. **Honesty rules in code, not just in docs.** The error map says "improvement" only when median and P90 are both lower on the held-out split. The crowd panel reports "did not lower error" when it did not. The stress panel warns below 5,000 conditions and calls it "not a stress-test result". The emergency panel checks precision against the counts. Raise (C): these rules are D's reading of guide 10.2, 11 and 14; C may hold a stricter one.
17. **The stand-in is a seeded placeholder.** `planner/tools/make_analytics_standin.js` (seed 4242) writes it, with a manifest hash. Its `stress.conditions_run` is 0, so the stress panel shows the placeholder grid with a warning. Nothing in it is a result.
18. **Raw JSON is read by a new adapter function, `fetchAnalyticsRaw`,** so the caveats travel with the data. `loadAnalytics` still returns the normalised form.
19. **Keyboard shortcuts yield to focused controls.** In D1 to D7 Space on a focused Step button started playback instead of stepping (the page-wide handler ran and cancelled the button's own action). Confirmed in the original code and fixed. Home and End are added. The rule is a pure function in `src/engine/access.js` with its own tests.
20. **Reduce motion is a switch.** It starts from `prefers-reduced-motion` and follows it when that changes. It removes the map trail fade and the CSS transitions. Playback has no easing animation, so no other motion exists to remove. Raise: none for the current UI.
21. **Offline rule is tested, not just stated.** The unit tests scan shipped JS, CSS and HTML for remote hosts (localhost only). The browser check also records every request during a run.
22. **Wide tables scroll inside their own focusable region** so the page never scrolls sideways at phone width. Analytics labels stack above values below 600 px.
23. **Browser check uses Playwright as an optional dependency.** It is not in `package.json`, since the planner and demo have no runtime dependencies. `PLAYWRIGHT_PATH` points at the package when it is not installed locally.
24. **Optimizer in the demo is a saved sample run, not a live ranking.** The demo ranks nothing itself. The panel is labelled as the saved run from the sample plan. The planner's own page runs the optimizer on the user's plan.
