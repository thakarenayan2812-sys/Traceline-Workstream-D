# Stand-in formats (Workstream D)

These are D's working assumptions where the guide is silent. Nothing here changes a frozen
contract. Items marked **ask** need confirmation from the named owner.

## Venue
Guide section 9.1 exactly. Checked by `src/core/validate.js`. Authoritative check: `shared/validate_contracts.py`.

## Replay (ask A)
```
{ schema_version, stand_in, scenario_id, run_id|null, venue_id, dt_s, seed, caveats[],
  steps: [ { k, t, truth:{x_m,y_m}, readings:[ {anchor_id, range_m|null, rssi_dbm|null, is_nlos, bias_m} ] } ] }
```
`truth` and `is_nlos`/`bias_m` are for display and scoring only. `buildModelInput` never reads them.

## Predictor input and output (ask B)
Input: `{ slots[8]{anchor_id,x_m,y_m,range_m,rssi_dbm,valid_flag}, previous_position_valid, x_prev_m, y_prev_m, dt_s, state }`.
Raw values are `null` when invalid; normalisation to neutral values happens inside B's `infer.js`.
Output: guide 9.3 canonical object. `confidence` stays `null` until its meaning is tested.

## Analytics (ask C)
```
{ error_map:{status,data}, crowd_degradation:{status,data}, stress:{status,data}, emergency_flags:{status,data} }
```
`status` is `ok`, `stand_in` or `not_yet_generated`. Anything else, or missing `data`, is shown as "not yet generated".
Per-section `data` layouts (proposed by D in D8; C confirms or changes them). The panels check these and show a section as "Not yet generated (data incomplete)" if a field is missing or malformed.

- **error_map.data**: `cell_size_m`, `support_threshold` (int), `split` (text), `before` and `after` (`{n, median_m, p90_m}`), `cells` (list of `{x_m, y_m, n_obs, mean_residual_m}`). Improvement is claimed only when `after` has lower median and P90 than `before`.
- **crowd_degradation.data**: `zones` (list of `{zone_id, density_people_m2, inside, outside}` with `{n, median_m, p90_m, sigma_m_mean}`), `crowd_input` (`{with_crowd, without_crowd}` with `{n, median_m, p90_m}`).
- **stress.data**: `conditions_run` (int), `failure_threshold_m`, `failure_rate` (0 to 1 or null), `grid` (`{x_axis, y_axis, x_labels, y_labels, values}` where `values` has one row per y label and one column per x label). Below 5,000 conditions the panel warns that it is not a stress-test result.
- **emergency_flags.data**: `threshold_sigma_m`, `error_threshold_m`, `total_steps`, `flagged_steps`, `high_error_steps`, `true_flags`, `precision`, `recall` (0 to 1 or null). The panel checks that precision equals `true_flags / flagged_steps`.

The stand-in file is `planner/fixtures/analytics.stand_in.json`, written by `tools/make_analytics_standin.js` (seed 4242). Its numbers are placeholders.
