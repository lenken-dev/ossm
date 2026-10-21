import { clamp, type Action } from "../funscript/model";
import type { Bookmark } from "../funscript/markers";
import { afterTime, byTime, markersRegions, type Area, type Content, type Generated } from "./model";
import { typed } from "./transforms";

/** The shapes a Generate function can take, their names, small graphs (32×16) and fields, in the order shown. */
export const SHAPES = {
  constant: { name: "Constant", graph: "2,8 30,8", fields: ["value"] },
  ramp: { name: "Ramp", graph: "2,14 30,2", fields: ["start", "end"] },
  sine: { name: "Sine", graph: "2,8 5.5,3.8 9,2 12.5,3.8 16,8 19.5,12.2 23,14 26.5,12.2 30,8", fields: ["min", "max", "period", "phase"] },
  triangle: { name: "Triangle", graph: "2,8 9,2 23,14 30,8", fields: ["min", "max", "period", "phase"] },
  trapezoid: { name: "Trapezoid", graph: "2,8 5.5,2 12.5,2 19.5,14 26.5,14 30,8", fields: ["min", "max", "period", "phase", "width"] },
  square: { name: "Square", graph: "2,2 9,2 9,14 16,14 16,2 23,2 23,14 30,14", fields: ["min", "max", "period", "phase"] },
  pulse: { name: "Pulse", graph: "2,2 5,2 5,14 16,14 16,2 19,2 19,14 30,14", fields: ["min", "max", "period", "phase", "width"] },
  noise: { name: "Noise", graph: "2,9 6,6 10,7 14,3 18,8 22,11 26,6 30,8", fields: ["min", "max", "period", "seed"] },
  spline: { name: "Spline", graph: "2,12 6,8 10,5 14,5 18,8 22,10 26,7 30,3", fields: [] },
} as const;
export type Shape = keyof typeof SHAPES;
export type ShapeField = "value" | "start" | "end" | "min" | "max" | "period" | "phase" | "width" | "seed";
/** The fields that hold a function's values, rather than how it moves between them. */
export const SPANNED: readonly ShapeField[] = ["value", "start", "end", "min", "max"];

/** A spline's knots, in time order: their times in % of the range, the first at 0 and the last at 100, and values, for Interval and Speed in % of the way from its Min to its Max. */
export type Knots = [number, number][];

/** A Generate function, its fields as typed, but a period and Interval's values in whole ms, typed in s: its shape and that shape's fields; a spline's knots, edited in the graph, as numbers, and for Interval and Speed the Min and Max of its scale. */
export type Func = { shape: Shape; knots?: Knots } & Partial<Record<ShapeField, string>>;

/** A new noise seed. */
export const newSeed = () => String(Math.floor(Math.random() * 1_000_000));

/** A function's lowest and highest value as typed, a spline's of its knots; 0 and 100 without any. */
export function extent(func: Func): [number, number] {
  const values = func.shape === "spline" ? func.knots!.map(([, v]) => v) : SPANNED.map((f) => typed(func[f] ?? "")).filter(Number.isFinite);
  return values.length ? [Math.min(...values), Math.max(...values)] : [0, 100];
}

/**
 * `func` as `shape`, keeping the fields the two share, the rest from what it
 * spans, lowest to highest, so the curve stays where it was: a constant's
 * value, a ramp's Start and End, a wave's Min and Max or a spline's knots.
 * A flat one is spread so the new shape shows: Out's and In's, given the
 * other's nearest value `toward`, keep their value and reach a quarter of the
 * way toward it; Interval's and Speed's half either side. Back to a constant,
 * Out and In keep the end away from `toward`, so switching back and forth
 * does not drift, Interval and Speed the middle. A new spline goes high, low,
 * high, low on four evenly spaced knots, so it shows what it can do.
 * Interval's and Speed's, on their own scale, given the value `own` to fall
 * back on when none is above 0, keep a wave's or noise's Min and Max for it,
 * else get room past both ends of half the lowest; going back, the scale is
 * the wave's Min and Max.
 */
export function reshaped(func: Func, shape: Shape, own?: number, toward?: number): Func {
  // An Interval or Speed spline's knots on its scale.
  const knotValue = (v: number) => (func.max === undefined ? v : typed(func.min ?? "") + (v * (typed(func.max) - typed(func.min ?? ""))) / 100);
  const spanned = func.shape === "constant" ? [func.value] : func.shape === "ramp" ? [func.start, func.end] : func.shape === "spline" ? func.knots!.map(([, v]) => String(knotValue(v))) : [func.min, func.max];
  // Interval's and Speed's above 0 only.
  const values = spanned.map((v) => typed(v ?? "")).filter((v) => Number.isFinite(v) && (own === undefined || v > 0));
  // None: a depth's whole range, Interval's or Speed's own value.
  let [lo, hi] = values.length ? [Math.min(...values), Math.max(...values)] : own === undefined ? [0, 100] : [own, own];
  // Interval's and Speed's in whole numbers, Interval's ms.
  const value = toward === undefined ? Math.round((lo + hi) / 2) : Math.abs(lo - toward) > Math.abs(hi - toward) ? lo : hi;
  if (lo === hi) [lo, hi] = toward === undefined ? [Math.round(lo * 0.5), Math.round(lo * 1.5)] : [lo, Math.round(lo + (toward - lo) / 4)].sort((a, b) => a - b);
  if (shape === "spline") {
    const knots = (lo: number, hi: number): Knots => [[0, hi], [100 / 3, lo], [200 / 3, hi], [100, lo]];
    if (own === undefined) return { shape, knots: knots(lo, hi) };
    const kept = typed(func.min ?? "") < typed(func.max ?? "");
    // Else room past both ends, half the lowest, keeping the scale above 0.
    const [min, max] = kept ? [typed(func.min!), typed(func.max!)] : [Math.round(lo / 2), Math.round(hi + lo / 2)];
    const scaled = (v: number) => Math.round(clamp(((v - min) / (max - min)) * 100, 0, 100));
    return { shape, min: String(min), max: String(max), knots: knots(scaled(lo), scaled(hi)) };
  }
  const all: Func = { value: String(value), start: String(lo), end: String(hi), min: String(lo), max: String(hi), period: shape === "noise" ? "1000" : "10000", phase: "0", width: "50", seed: newSeed(), ...func };
  return { shape, ...Object.fromEntries(SHAPES[shape].fields.map((f) => [f, all[f]])) };
}

/**
 * Generate's setup: how the next point's time is found, whether the first
 * point goes on In or Out, how many points in a row go on each
 * (1 when not set), and a function for each of
 * Interval (ms), Speed, and Out and In (depths in % of the box, from its Out
 * edge). Markers timing puts the points at the bookmarks instead.
 */
export interface GenerateSetup {
  timing: "interval" | "speed" | "markers";
  /** With Markers timing, the names of the bookmarks it leaves out. */
  skip?: string[];
  first: "in" | "out";
  /** Points in a row on Out and on In, as typed; whole numbers from 1. */
  outs?: string;
  ins?: string;
  interval: Func;
  speed: Func;
  out: Func;
  in: Func;
}

/** A function of Generate's setup or Repeat's Time. */
export type FuncKey = "interval" | "speed" | "out" | "in" | "time";
/** Whether the function `key` is on a scale of its own, in the timing view, rather than in % of the box. */
export const ownScale = (key: FuncKey) => key !== "out" && key !== "in";
/** The parts of Generate's setup, shown one at a time, with their handles in the graph: Layout its box, First and the runs on Out and In, Timing its timing and Interval or Speed. */
export type GenPart = "position" | "timing" | "out" | "in";

export const constant = (value: string): Func => ({ shape: "constant", value });
export const GENERATE_DEFAULTS: GenerateSetup = { timing: "interval", first: "out", interval: constant("1000"), speed: constant("100"), out: constant("0"), in: constant("100") };

/**
 * Whether Generate's point `i` goes on Out: First's side's run, then the
 * other's, over and over; null while a run is not a whole number from 1.
 */
function onOut(setup: GenerateSetup, i: number) {
  const [outs, ins] = [typed(setup.outs ?? "1"), typed(setup.ins ?? "1")];
  if (!(Number.isInteger(outs) && outs >= 1 && Number.isInteger(ins) && ins >= 1)) return null;
  const k = i % (outs + ins);
  return setup.first === "out" ? k < outs : k >= ins;
}

/** A random value, 0–1, for `seed` and `k`. */
function hashed(seed: number, k: number) {
  let h = Math.imul(k ^ Math.imul(seed, 0x27d4eb2d), 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 2 ** 32;
}

/** Each spline's second derivatives at its knots, worked out once per knots. */
const curvatures = new WeakMap<Knots, number[]>();

/** The natural cubic spline through `knots` at `u` % of the range. */
export function splineAt(knots: Knots, u: number) {
  const n = knots.length;
  let m = curvatures.get(knots);
  if (!m) {
    // The tridiagonal system for the inner knots, the ends' 0 as a natural spline's, by the Thomas algorithm.
    const h = knots.slice(1).map(([x], i) => x - knots[i][0]);
    const [c, d] = [new Array<number>(n).fill(0), new Array<number>(n).fill(0)];
    for (let i = 1; i < n - 1; i++) {
      const rhs = 6 * ((knots[i + 1][1] - knots[i][1]) / h[i] - (knots[i][1] - knots[i - 1][1]) / h[i - 1]);
      const w = 2 * (h[i - 1] + h[i]) - h[i - 1] * c[i - 1];
      [c[i], d[i]] = [h[i] / w, (rhs - h[i - 1] * d[i - 1]) / w];
    }
    m = new Array<number>(n).fill(0);
    for (let i = n - 2; i > 0; i--) m[i] = d[i] - c[i] * m[i + 1];
    curvatures.set(knots, m);
  }
  u = clamp(u, 0, 100);
  const next = knots.findIndex(([x]) => x > u);
  const i = clamp((next < 0 ? n : next) - 1, 0, n - 2);
  const [[x0, y0], [x1, y1]] = [knots[i], knots[i + 1]];
  const h = x1 - x0;
  const [a, b] = [(x1 - u) / h, (u - x0) / h];
  return a * y0 + b * y1 + (((a ** 3 - a) * m[i] + (b ** 3 - b) * m[i + 1]) * h * h) / 6;
}

/**
 * A function's value `t` ms into a range `span` ms long; NaN while a field
 * is refused, or a period is not above 0. A ramp runs across the range; waves
 * start with it, Sine, Triangle and Trapezoid halfway up and rising, Square
 * and Pulse on Max; a trapezoid holds Width % of each period, half on Max and
 * half on Min. Noise eases between random values one Period apart.
 */
export function funcAt(func: Func, t: number, span: number) {
  const f = (field: ShapeField) => typed(func[field] ?? "");
  if (func.shape === "constant") return f("value");
  if (func.shape === "ramp") return f("start") + (f("end") - f("start")) * (span ? t / span : 0);
  if (func.shape === "spline") {
    const v = splineAt(func.knots!, span ? (t / span) * 100 : 0);
    // On its own scale, clamped to Min–Max; refused unless Min is below Max.
    return func.max === undefined ? v : f("min") < f("max") ? f("min") + (clamp(v, 0, 100) * (f("max") - f("min"))) / 100 : NaN;
  }
  const [min, max, period] = [f("min"), f("max"), f("period")];
  if (!(period > 0)) return NaN;
  const along = (w: number) => min + (max - min) * w;
  if (func.shape === "noise") {
    const [seed, k] = [f("seed"), Math.floor(t / period)];
    if (!Number.isInteger(seed)) return NaN;
    const u = t / period - k;
    return along(hashed(seed, k) + (hashed(seed, k + 1) - hashed(seed, k)) * u * u * (3 - 2 * u));
  }
  const u = (((t / period + f("phase") / 100) % 1) + 1) % 1;
  if (func.shape === "sine") return along((1 + Math.sin(2 * Math.PI * u)) / 2);
  const triangle = Math.abs(2 * ((u + 0.75) % 1) - 1);
  if (func.shape === "triangle") return along(triangle);
  // A triangle made steeper about its middle, clipped to Min and Max; held near all the period at Width 100.
  if (func.shape === "trapezoid") return along(clamp((triangle - 0.5) / (1 - clamp(f("width") / 100, 0, 0.99)) + 0.5, 0, 1));
  const edge = func.shape === "square" ? 0.5 : f("width") / 100;
  return Number.isNaN(u + edge) ? NaN : along(u < edge ? 1 : 0);
}

/**
 * Generate's points in `range`: runs of points on Out and on In in turn,
 * from its start, the last at or before its end; null while a field is
 * refused. Each next point goes the Interval after the one before, or with
 * Speed timing at the first ms where a segment to the other side's function
 * is no faster than the Speed, so a point in a run waits as long as a stroke
 * would; at least 1 ms after either way. With Markers timing, one goes at
 * each of the sorted bookmarks `marks` in the range it doesn't skip, one per
 * ms; null without any.
 */
export function generated(setup: GenerateSetup, range: Area, marks: Bookmark[]): Action[] | null {
  const span = range.to - range.from;
  /** The position a point on `func` gets at `at`, its depth from the range's Out edge, rounded; NaN while a field is refused. */
  const depthAt = (func: Func, at: number) => Math.round(range.high - (clamp(funcAt(func, at - range.from, span), 0, 100) * (range.high - range.low)) / 100);
  if (setup.timing === "markers") {
    const times = [...new Set(markTimes(setup, marks).filter((t) => t >= range.from && t <= range.to))];
    if (onOut(setup, 0) === null) return null;
    const made = times.map((at, i) => ({ at, pos: depthAt(onOut(setup, i) ? setup.out : setup.in, at) }));
    return made.length && !made.some((a) => Number.isNaN(a.pos)) ? made : null;
  }
  if (onOut(setup, 0) === null) return null;
  const made: Action[] = [];
  for (let at = range.from; at <= range.to; ) {
    const out = onOut(setup, made.length);
    const pos = depthAt(out ? setup.out : setup.in, at);
    const step = setup.timing === "speed" ? Math.max(funcAt(setup.speed, at - range.from, span), 1) : funcAt(setup.interval, at - range.from, span);
    // An Interval not above 0 is refused.
    if (Number.isNaN(pos) || !(step > 0)) return null;
    made.push({ at, pos });
    if (setup.timing === "interval") {
      at += Math.max(Math.round(step), 1);
      continue;
    }
    // A ms at a time, so no crossing is missed: as many steps in all as the range has ms. Between the rounded depths, as the points get them; to the other side even within a run.
    const next = out ? setup.in : setup.out;
    let dt = 1;
    while (at + dt <= range.to && Math.abs(depthAt(next, at + dt) - pos) * 1000 > step * dt) dt++;
    at += dt;
  }
  return made;
}

/** The times of the bookmarks `marks` that Markers timing with `setup` puts points at: those with names it doesn't skip. */
const markTimes = (setup: GenerateSetup, marks: Bookmark[]) => marks.filter((b) => !setup.skip?.includes(b.name)).map((b) => b.time);

/** `actions` with the Markers region `r`'s points put again at the bookmarks `marks` in its box it doesn't skip: none without any there; as they are while its setup is refused. */
export function refilled(actions: Action[], r: Generated, marks: Bookmark[]) {
  const made = markTimes(r.generate, marks).some((t) => t >= r.from && t <= r.to) ? generated(r.generate, r, marks) : [];
  return made ? [...actions.slice(0, byTime(actions, r.from)), ...made, ...actions.slice(afterTime(actions, r.to))] : actions;
}

/**
 * `s` with the bookmarks `bookmarks`: each Markers region, in an instance
 * too, with a bookmark added, gone or renamed in its box puts its points
 * again on the bookmarks, as a rename can change which it skips.
 */
export function withBookmarks<T extends Content>(s: T, bookmarks: Bookmark[]): T {
  const key = (b: Bookmark) => JSON.stringify([b.time, b.name]);
  const [was, now] = [new Set(s.bookmarks.map(key)), new Set(bookmarks.map(key))];
  const changed = [...s.bookmarks.filter((b) => !now.has(key(b))), ...bookmarks.filter((b) => !was.has(key(b)))].map((b) => b.time);
  const touched = markersRegions(s.regions).filter((r) => changed.some((t) => t >= r.from && t <= r.to));
  return { ...s, bookmarks, actions: touched.reduce((list, r) => refilled(list, r, bookmarks), s.actions) };
}

/**
 * Repeat's setup: how many copies in all, as typed, the pattern being the
 * first, and a function each for Time, in % of the pattern's Length, and
 * Out and In, depths in % of its box's height, from its Out edge.
 */
export interface RepeatSetup {
  count: string;
  time: Func;
  out: Func;
  in: Func;
}

/** What a Repeat region keeps: its setup and its pattern, the points timed from the box's start, the box's Length in whole ms and its lowest and highest position. */
export type RepeatKept = RepeatSetup & { pattern: Action[]; length: number; bottom: number; top: number };

export const REPEAT_DEFAULTS: RepeatSetup = { count: "4", time: constant("100"), out: constant("0"), in: constant("100") };

/** The shapes that run across a function's range, rather than in time. */
export const RANGED: Shape[] = ["ramp", "spline"];

/**
 * Repeat's copies of the points of `pattern` in its box from `from`,
 * `length` ms long, from `bottom` to `top`: each the box stretched to Length
 * by Time, read at the copy's start, end to end, a point at the box's end
 * left to the next copy's first but the last's; their depths mapped from the
 * box's Out–In onto Out's–In's, read at each point's time. Points on the
 * same ms merge, the later kept. Time is read at each copy's start, its ramp
 * and spline across the copies' time, which they set, so it is found by
 * halving; its waves, and Out and In, in time. Gives the copies' starts and their end, and their
 * points, null while a field is refused: the starts then as at 100%; null
 * without a valid Count or Length.
 */
export function repeated(setup: RepeatSetup, from: number, pattern: Action[], length: number, bottom: number, top: number) {
  const count = typed(setup.count);
  if (!(Number.isInteger(count) && count >= 1 && length > 0)) return null;
  const ranged = RANGED.includes(setup.time.shape);
  /** The copies' starts and end with a ramp or spline across `span` ms. */
  const run = (span: number) => {
    const starts = [from];
    let refused = false;
    for (let k = 0; k < count; k++) {
      const time = funcAt(setup.time, starts[k] - from, ranged ? span : 0);
      refused ||= !(time > 0);
      starts.push(starts[k] + (length * (time > 0 ? time : 100)) / 100);
    }
    return { starts, refused };
  };
  // The span the copies fill exactly: they outrun one too short, and fall within one long enough.
  let [lo, hi] = [0, length * count];
  if (ranged) {
    for (let i = 0; i < 60 && run(hi).starts[count] - from > hi; i++) hi *= 2;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (run(mid).starts[count] - from > mid) lo = mid;
      else hi = mid;
    }
  }
  const { starts, refused } = run(hi);
  const end = Math.round(starts[count]);
  const inBox = pattern.filter((a) => a.at >= from && a.at <= from + length);
  if (refused || !inBox.length) return { starts, end, actions: null };
  const span = end - from;
  const out: Action[] = [];
  for (let k = 0; k < count; k++) {
    for (const a of inBox) {
      if (a.at === from + length && k < count - 1) continue;
      const at = Math.round(starts[k] + ((a.at - from) * (starts[k + 1] - starts[k])) / length);
      const [outer, inner] = [clamp(funcAt(setup.out, at - from, span), 0, 100), clamp(funcAt(setup.in, at - from, span), 0, 100)];
      const v = top > bottom ? (top - a.pos) / (top - bottom) : 0.5;
      const pos = Math.round(clamp(top - ((outer + v * (inner - outer)) * (top - bottom)) / 100, 0, 100));
      if (Number.isNaN(pos)) return { starts, end, actions: null };
      if (out[out.length - 1]?.at === at) out.pop();
      out.push({ at, pos });
    }
  }
  return { starts, end, actions: out };
}

/** Repeat's box fields as numbers, Length in whole ms from shown seconds, Out and In typed as depths, as positions `top` and `bottom`; null while one is refused: a Length not above 0, or depths outside 0–100 or Out past In. */
export function repeatParams(fields: { length: string; out: string; in: string }) {
  const [length, out, inn] = [Math.round(typed(fields.length) * 1000), typed(fields.out), typed(fields.in)];
  return length > 0 && out >= 0 && out <= inn && inn <= 100 ? { length, bottom: 100 - inn, top: 100 - out } : null;
}

/** Generate's range fields as numbers, its times in ms from shown seconds, Out and In typed as depths, as positions; null while one is refused: times before 0, To before From, or depths outside 0–100 or Out past In. */
export function rangeParams(fields: { from: string; to: string; out: string; in: string }, zero: number): Area | null {
  const [from, to] = [Math.round(typed(fields.from) * 1000) + zero, Math.round(typed(fields.to) * 1000) + zero];
  const [out, inn] = [typed(fields.out), typed(fields.in)];
  return from >= 0 && to >= from && out >= 0 && out <= inn && inn <= 100 ? { from, to, low: 100 - inn, high: 100 - out } : null;
}

/** Generate's range fields for `area`, its times in seconds from `zero`, its positions as depths. */
export const rangeFields = (area: Area, zero: number) => ({ from: String((area.from - zero) / 1000), to: String((area.to - zero) / 1000), out: String(100 - area.high), in: String(100 - area.low) });

/** Least time between a Generate spline's knots, in % of the range. */
export const KNOT_GAP = 0.1;

export type ToolKind = "scale" | "shift" | "invert" | "speed" | "generate" | "repeat" | "grid";

/** The advanced editor's tools: their names, undo labels, and the before and after strokes of their small graphs, 56×24. */
export const TOOLS: { kind: ToolKind; name: string; verb: string; before: string; after: string }[] = [
  { kind: "scale", name: "Scale", verb: "Scale", before: "4,16 12,8 20,16 28,8", after: "4,20 20,4 36,20 52,4" },
  { kind: "shift", name: "Shift depth", verb: "Shift depth of", before: "4,20 14,12 24,20 34,12 44,20 52,12", after: "4,12 14,4 24,12 34,4 44,12 52,4" },
  { kind: "invert", name: "Invert", verb: "Invert", before: "4,20 14,12 24,20 34,12 44,20 52,12", after: "4,4 14,12 24,4 34,12 44,4 52,12" },
  { kind: "speed", name: "Max speed", verb: "Limit speed of", before: "4,20 12,4 20,20 28,4 36,20 44,4 52,20", after: "4,20 12,12 20,20 28,12 36,20 44,12 52,20" },
  // Strokes up to a sine for Out, down to a constant In; the sine faint behind them.
  { kind: "generate", name: "Generate", verb: "Generate", before: "4,8 6,7 8,6 10,5.2 12,4.5 14,4.1 16,4 18,4.1 20,4.5 22,5.2 24,6 26,7 28,8 30,9 32,10 34,10.8 36,11.5 38,11.9 40,12 42,11.9 44,11.5 46,10.8 48,10 50,9 52,8", after: "4,20 8,6 12,20 16,4 20,20 24,6 28,20 32,10 36,20 40,12 44,20 48,10 52,20" },
  // The pattern in pink, then its two copies in grey.
  { kind: "repeat", name: "Repeat", verb: "Repeat", before: "20,20 24,6 28,20 32,12 36,20 40,6 44,20 48,12 52,20", after: "4,20 8,6 12,20 16,12 20,20" },
  // The grid in grey, as one line, and strokes on its crossings.
  { kind: "grid", name: "Grid", verb: "", before: "4,4 52,4 52,12 4,12 4,20 52,20 52,4 40,4 40,20 28,20 28,4 16,4 16,20 4,20 4,4", after: "4,20 16,4 28,12 40,4 52,20" },
];
