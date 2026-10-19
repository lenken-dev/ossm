// Runs in the follow worker, which loads the WASM; see `hooks/useFollow.ts`.
import { FollowCalculator } from "@ossm-rs/trajectory-recorder";
import type { Funscript } from "./StreamPanel";

/** Machine settings, 0–1, on a machine range `rangeMm` long. */
export interface MachineSettings {
  rangeMm: number;
  depth: number;
  stroke: number;
  speed: number;
  jerk: number;
}

let current: { rangeMm: number; calc: FollowCalculator } | null = null;

/** The share of `script`'s points after the first the machine reaches on time with `s`. */
function reached(at: Uint32Array, pos: Float64Array, s: MachineSettings) {
  if (current?.rangeMm !== s.rangeMm) {
    current?.calc.free();
    current = { rangeMm: s.rangeMm, calc: new FollowCalculator(s.rangeMm) };
  }
  return current.calc.reached(at, pos, s.depth, s.stroke, s.speed, s.jerk);
}

/** Time before the test strokes, past the stream's entry ramp (`ENTRY_HOLD_MS` and `ENTRY_RAMP_MS` in the stream sequencer). */
const WARMUP_MS = 3000;
/** Test strokes, each way counting as one. */
const STROKES = 8;

/**
 * The fastest full strokes, between 0 and 100, the machine follows with `s`,
 * in depth per second: each turn reached on time, give or take a tenth of
 * the stroke. Infinity without a stroke length; 0 at speed 0.
 */
export function maxScriptSpeed(s: MachineSettings): number {
  if (s.depth * s.stroke <= 0) return Infinity;
  const follows = (speed: number) => {
    const ms = Math.max(Math.round(100_000 / speed), 1);
    const at = Uint32Array.from({ length: STROKES + 2 }, (_, k) => (k ? WARMUP_MS + (k - 1) * ms : 0));
    const pos = Float64Array.from(at, (_, k) => (k > 1 && k % 2 === 0 ? 100 : 0));
    return reached(at, pos, s) === 1;
  };
  let lo = 0;
  let hi = 100;
  for (; follows(hi) && hi < 100_000; hi *= 2) lo = hi;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (follows(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Share of a script's points the machine must reach on time for the script to count as followed. */
const FOLLOWED = 0.95;

/** The share of `script`'s points after the first the machine reaches on time with `s`, played `rate` times as fast. */
export function scriptReached(script: Funscript, rate: number, s: MachineSettings): number {
  const at = rate === 1 ? script.at : Uint32Array.from(script.at, (t) => Math.round(t / rate));
  return reached(at, script.pos, s);
}

/**
 * The lowest speed setting, in whole percent, at which the machine reaches
 * `FOLLOWED` of `script`'s points on time with `s`, played `rate` times as
 * fast; null when even 100% does not.
 */
export function neededSpeed(script: Funscript, rate: number, s: Omit<MachineSettings, "speed">): number | null {
  const follows = (percent: number) => scriptReached(script, rate, { ...s, speed: percent / 100 }) >= FOLLOWED;
  if (!follows(100)) return null;
  let lo = 0;
  let hi = 100;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (follows(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** What the follow worker works out. */
export type FollowRequest =
  | { kind: "max"; settings: MachineSettings }
  | { kind: "script"; script: Funscript; rate: number; settings: Omit<MachineSettings, "speed">; speed: number };

/** The answer to a request: `maxScriptSpeed`'s, or the speed `script` needs and the share of it reached at `speed`. */
export type FollowResult<R extends FollowRequest> = R extends { kind: "max" } ? number : { needed: number | null; reached: number };

export function follow(request: FollowRequest): FollowResult<FollowRequest> {
  if (request.kind === "max") return maxScriptSpeed(request.settings);
  const { script, rate, settings, speed } = request;
  return { needed: neededSpeed(script, rate, settings), reached: scriptReached(script, rate, { ...settings, speed }) };
}
