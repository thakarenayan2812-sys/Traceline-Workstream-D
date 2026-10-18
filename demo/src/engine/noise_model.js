// Range sigma used to weight the baselines. Same guide 8 starting rule as the planner's stand-in simulator.
import { STAND_IN_SIGNAL } from "../../../planner/src/adapters/simulator_adapter.js";

/** sigma(range) = a + b x range, floored so a zero range never gives an infinite weight. */
export const sigmaForRange = (r) => Math.max(0.05, STAND_IN_SIGNAL.range_sigma_a_m + STAND_IN_SIGNAL.range_sigma_b * Math.max(0, r));
