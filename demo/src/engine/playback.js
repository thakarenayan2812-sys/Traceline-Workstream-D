// Playback state for the replay (pure, immutable). Time comes from the caller, so tests need no clock.
import { DT_S } from "../../../planner/src/core/constants.js";

export const SPEEDS = Object.freeze([0.25, 0.5, 1, 2, 4]);

export function createPlayback(stepCount) {
  if (!Number.isInteger(stepCount) || stepCount < 1) throw new RangeError("A replay needs at least one step.");
  return Object.freeze({ stepCount, index: 0, playing: false, speedIndex: 2, carry: 0 });
}

const clampIndex = (s, i) => Math.min(s.stepCount - 1, Math.max(0, Math.round(i)));
export const speed = (s) => SPEEDS[s.speedIndex];
export const play = (s) => (s.index >= s.stepCount - 1 ? { ...s, index: 0, playing: true, carry: 0 } : { ...s, playing: true });
export const pause = (s) => ({ ...s, playing: false, carry: 0 });
export const toggle = (s) => (s.playing ? pause(s) : play(s));
export const reset = (s) => ({ ...s, index: 0, playing: false, carry: 0 });
export const seek = (s, i) => ({ ...s, index: clampIndex(s, i), carry: 0 });
export const stepBy = (s, n) => ({ ...s, playing: false, index: clampIndex(s, s.index + n), carry: 0 });
export const setSpeed = (s, speedIndex) => ({ ...s, speedIndex: Math.min(SPEEDS.length - 1, Math.max(0, speedIndex)) });

/**
 * Advance by `wallSeconds` of real time. The replay advances speed x wallSeconds of scenario time, in steps of DT_S.
 * Stops at the last step and pauses there.
 */
export function tick(s, wallSeconds) {
  if (!s.playing) return s;
  const scenario = s.carry + speed(s) * wallSeconds;
  const whole = Math.floor(scenario / DT_S);
  const index = s.index + whole;
  if (index >= s.stepCount - 1) return { ...s, index: s.stepCount - 1, playing: false, carry: 0 };
  return { ...s, index, carry: scenario - whole * DT_S };
}
