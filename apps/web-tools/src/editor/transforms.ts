import { clamp, speed, type Action } from "../funscript/model";
import { depthRange, movedBy, typed, type Region } from "./model";

/** A transform's result: the new points, and the indices of the affected ones among them; the regions, when it moves them. */
interface Transformed {
  actions: Action[];
  selected: Set<number>;
  regions?: Region[];
}

/**
 * Scale the points `picked` of `actions` by `time` % and onto `low`–`high`, as positions. In
 * time from the first, which stays: the points up to the last stretch along,
 * those in between too so the order stays, and later ones move by the change
 * in length, as do the `regions` after them; points landing on the same ms
 * merge, the later kept. In depth
 * their range maps onto `low`–`high`, flipped when `low` is above; all at one
 * depth, they go halfway between.
 */
export function scaled(actions: Action[], picked: number[], time: number, low: number, high: number, regions: Region[]): Transformed {
  const hit = new Set(picked);
  const [i0, i1] = [picked[0], picked[picked.length - 1]];
  const t0 = actions[i0].at;
  const stretched = (at: number) => Math.round(t0 + ((at - t0) * time) / 100);
  const shift = stretched(actions[i1].at) - actions[i1].at;
  const depths = picked.map((i) => actions[i].pos);
  const [lo, hi] = [Math.min(...depths), Math.max(...depths)];
  const mapped = (pos: number) => (hi > lo ? low + ((pos - lo) * (high - low)) / (hi - lo) : (low + high) / 2);
  const next: Action[] = [];
  const moved = new Set<number>();
  actions.forEach((a, i) => {
    const at = i < i0 ? a.at : i <= i1 ? stretched(a.at) : a.at + shift;
    if (next[next.length - 1]?.at === at) {
      next.pop();
      moved.delete(next.length);
    }
    if (hit.has(i)) moved.add(next.length);
    next.push({ at, pos: hit.has(i) ? Math.round(clamp(mapped(a.pos), 0, 100)) : a.pos });
  });
  return { actions: next, selected: moved, regions: regions.map((r) => (r.from > actions[i1].at ? movedBy(r, shift) : r)) };
}

/** Scale's fields as numbers, Out and In typed as depths, as positions `high` and `low`; null while one is refused: a time of 0 or less would fold the points onto each other, and the depths are 0–100. */
export function scaleParams(fields: { time: string; out: string; in: string }) {
  const [time, depths] = [typed(fields.time), depthRange(fields.out, fields.in, { flip: true })];
  return time > 0 && depths ? { time, ...depths } : null;
}

/** Shift depth's fields as numbers, typed as depths, as positions: the Offset deeper the higher, Out the limit `max`, In `min`; null while one is refused: limits outside the depths, rather than quietly clamped, or Out past In. */
export function shiftParams(fields: { offset: string; out: string; in: string }) {
  const [offset, depths] = [typed(fields.offset), depthRange(fields.out, fields.in)];
  return Number.isFinite(offset) && depths ? { offset: -offset, min: depths.low, max: depths.high } : null;
}

/** Shift the depth of the points `picked` of `actions` by `offset`, then keep it within `min`–`max`. */
export function shifted(actions: Action[], picked: number[], offset: number, min: number, max: number): Transformed {
  const hit = new Set(picked);
  return { actions: actions.map((a, i) => (hit.has(i) ? { at: a.at, pos: Math.round(clamp(a.pos + offset, min, max)) } : a)), selected: hit };
}

/**
 * Slow the segments of `actions` touching the points `picked` to `limit`,
 * moving only those points and only one way: with `out` up, else down, each as
 * little as it takes. A pass forward against the point before, then back
 * against the one after; times stay.
 */
export function speedLimited(actions: Action[], picked: number[], limit: number, out: boolean): Transformed {
  const hit = new Set(picked);
  const pos = actions.map((a) => a.pos);
  const fix = (i: number, j: number) => {
    if (!hit.has(i)) return;
    const reach = (limit * Math.abs(actions[i].at - actions[j].at)) / 1000;
    if (out && pos[i] < pos[j] - reach) pos[i] = Math.max(Math.ceil(pos[j] - reach), 0);
    if (!out && pos[i] > pos[j] + reach) pos[i] = Math.min(Math.floor(pos[j] + reach), 100);
  };
  for (let i = 1; i < pos.length; i++) fix(i, i - 1);
  for (let i = pos.length - 2; i >= 0; i--) fix(i, i + 1);
  return { actions: actions.map((a, i) => (pos[i] === a.pos ? a : { at: a.at, pos: pos[i] })), selected: hit };
}

/** The fastest segment of `actions` touching the points `picked`; null without any. */
export function fastestOf(actions: Action[], picked: number[]) {
  const hit = new Set(picked);
  const touched = [...actions.keys()].filter((i) => i > 0 && (hit.has(i) || hit.has(i - 1)));
  return touched.length ? Math.max(...touched.map((i) => speed(actions[i - 1], actions[i]))) : null;
}

/** The grid tool's fields as typed: its time interval in seconds, its depth interval and its own depths. */
export type GridFields = { time: string; depth: string; depths: string };

/**
 * The grid tool's fields as numbers: the time interval in ms, null unless
 * positive, and the positions of its depths, whole: the depth interval's
 * multiples from 0 and the listed ones, those outside 0–100 left out.
 */
export function gridParams(fields: GridFields) {
  const [step, every] = [Math.round(typed(fields.time) * 1000), typed(fields.depth)];
  const multiples = every > 0 ? Array.from({ length: Math.floor(100 / every) + 1 }, (_, k) => k * every) : [];
  const depths = [...multiples, ...fields.depths.split(/[\s,;]+/).map(typed)].filter((d) => d >= 0 && d <= 100);
  return { step: step > 0 ? step : null, positions: [...new Set(depths.map((d) => 100 - Math.round(d)))] };
}
