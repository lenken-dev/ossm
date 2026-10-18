import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactElement, type ReactNode } from "react";
import { AlertDialog, Box, Button, Callout, Checkbox, Flex, Heading, HoverCard, IconButton, Popover, SegmentedControl, Select, Separator, Slider, Switch, Text, TextField, useThemeContext } from "@radix-ui/themes";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, ClipboardIcon, ComponentInstanceIcon, MagnifyingGlassIcon, PlusIcon, LockOpen1Icon, Pencil1Icon, TrashIcon, MixerHorizontalIcon, ColumnSpacingIcon, CopyIcon, MoveIcon, ResetIcon, CounterClockwiseClockIcon, DoubleArrowDownIcon, DoubleArrowLeftIcon, DoubleArrowRightIcon, DoubleArrowUpIcon, Cross2Icon, Crosshair2Icon, DownloadIcon, ExclamationTriangleIcon, FileIcon, GearIcon, HeightIcon, OpenInNewWindowIcon, PinLeftIcon, PauseIcon, PlayIcon, ScissorsIcon, ShuffleIcon, TrackNextIcon, TrackPreviousIcon, UploadIcon, VideoIcon, ViewVerticalIcon } from "@radix-ui/react-icons";
import { bisector } from "d3";
import { usePersistedState } from "../hooks/usePersistedState";
import { SENT_SCRIPT_KEY } from "../StreamPanel";
import { formatScriptTime, formatTimeTick, readFunscript, timeTicks } from "../StreamPanel";
import { LabeledSlider } from "../TrajectoryPanel";
import { GraphLayout } from "./GraphPage";

interface Action {
  /** Time in ms. */
  at: number;
  /** 0 (deep end) to 100 (shallow end). */
  pos: number;
}

interface Script {
  name: string;
  /** Sorted by time, no two at the same time. */
  actions: Action[];
  /** The opened file without its actions, saved with them so keys the editor does not know stay; missing in scripts kept before markers. */
  file?: Record<string, unknown>;
  chapters: Chapter[];
  bookmarks: Bookmark[];
  /** Sorted by time, never overlapping. */
  regions: Region[];
}

/** What an edit changes, undo restores and saving keeps: the points, markers and regions. */
type Content = Pick<Script, "actions" | "chapters" | "bookmarks" | "regions">;
const sameContent = (a: Content, b: Content) => a.actions === b.actions && a.chapters === b.chapters && a.bookmarks === b.bookmarks && a.regions === b.regions;

/** A named time range, in ms, from `metadata.chapters`; other properties of the loaded one are kept. */
interface Chapter {
  name: string;
  start: number;
  end: number;
  [other: string]: unknown;
}

/** A named time, in ms, from `metadata.bookmarks`; other properties of the loaded one are kept. */
interface Bookmark {
  name: string;
  time: number;
  [other: string]: unknown;
}

type Marker = Chapter | Bookmark;

/** `list` with the markers in `to` swapped for what they map to. */
const swapped = <T extends Marker>(list: T[], to: Map<Marker, Marker>) => list.map((m) => (to.get(m) as T | undefined) ?? m);

/** A time range, in ms, and depth range. */
interface Area {
  from: number;
  to: number;
  low: number;
  high: number;
}

/** The area with corners `a` and `b`. */
const spanned = (a: Action, b: Action): Area => ({
  from: Math.min(a.at, b.at),
  to: Math.max(a.at, b.at),
  low: Math.min(a.pos, b.pos),
  high: Math.max(a.pos, b.pos),
});

/** `area` grown to take in `a`. */
const extended = (area: Area, a: Action): Area => ({
  from: Math.min(area.from, a.at),
  to: Math.max(area.to, a.at),
  low: Math.min(area.low, a.pos),
  high: Math.max(area.high, a.pos),
});

/**
 * A stretch of points made by Generate: its box, times in whole ms, and its
 * own copy of the setup. Its points are the ones in its time; they are locked.
 */
interface Generated extends Area {
  generate: GenerateSetup;
}

/**
 * A stretch of points made by Repeat: the copies' time, in whole ms, and its
 * own copy of the setup with the pattern it repeats. Locked as a Generate
 * region.
 */
interface Repeated {
  from: number;
  to: number;
  repeat: RepeatKept;
}

/**
 * An inserted snippet: its own copies of the snippet's points, the ones in
 * its time, and generator regions, inside it, with its name; times in whole
 * ms. Its time runs from its first to its last point, widened to its
 * regions' boxes. Locked as a generator region; its regions only show once
 * it is unlocked.
 */
interface Instance {
  from: number;
  to: number;
  snippet: { name: string; regions: Inner[] };
}

/** A region made by a tool, which an instance can hold: Generate's or Repeat's. */
type Inner = Generated | Repeated;
/** A locked stretch of points: a generator region or a snippet instance. */
type Region = Inner | Instance;
const isInstance = (r: Region): r is Instance => "snippet" in r;
const isRepeat = (r: Region): r is Repeated => "repeat" in r;
/** The Markers regions of `regions` and in their instances: those that put points on the bookmarks. */
const markersRegions = (regions: Region[]) => generators(regions).filter((r): r is Generated => "generate" in r && r.generate.timing === "markers");
/** What the undo history calls `r`: a region, or a snippet by its name. */
const regionNoun = (r: Region) => (isInstance(r) ? `snippet "${r.snippet.name}"` : "region");

/** An instance named `name` of `clip`'s points and its generator regions: from its first to its last point, widened to their boxes. */
const instanceOf = (name: string, clip: Clip): Instance => {
  const inner = generators(clip.regions);
  const { actions } = clip;
  return { from: Math.min(actions[0].at, ...inner.map((r) => r.from)), to: Math.max(actions[actions.length - 1].at, ...inner.map((r) => r.to)), snippet: { name, regions: inner } };
};

/** The generator regions of `regions` and in their instances. */
const generators = (regions: Region[]) => regions.flatMap((r) => (isInstance(r) ? r.snippet.regions : [r]));

/** The region of `regions` whose time holds `at`; none outside them. */
const regionAt = (regions: Region[], at: number) => regions.find((r) => at >= r.from && at <= r.to);

/** `r` moved `dt` ms in time, an instance's regions with it. */
const movedBy = <R extends Region>(r: R, dt: number): R =>
  ({ ...r, from: r.from + dt, to: r.to + dt, ...(isInstance(r) && { snippet: { ...r.snippet, regions: r.snippet.regions.map((i) => movedBy(i, dt)) } }) });

/** Points to place, timed from the first, with the regions they carry, timed alike: copied, pasted, moved or the advanced editor's result. */
interface Clip {
  actions: Action[];
  regions: Region[];
}

/** `clip` moved `dt` ms in time, its regions with it. */
const clipBy = (clip: Clip, dt: number): Clip => ({ actions: clip.actions.map((a) => ({ at: a.at + dt, pos: a.pos })), regions: clip.regions.map((r) => movedBy(r, dt)) });

/** A saved advanced-editor document: its points, at least two, and generator regions, timed from its first point at 0. */
interface Snippet extends Clip {
  name: string;
}

/** A folder of the snippet library, with its folders and snippets. */
interface Folder {
  folder: string;
  items: Entry[];
}

/** A row of the snippet library; its name is unique in its folder, among folders and snippets alike. */
type Entry = Folder | Snippet;
const isFolder = (e: Entry): e is Folder => "folder" in e;
const entryName = (e: Entry) => (isFolder(e) ? e.folder : e.name);

/** The snippet library as it is kept and exported. */
interface LibraryFile {
  ossmRsWebTools: { version: 1; snippets: Entry[] };
}

/** Whether the entry at `path`, by its folders' and its own name, is `folder` or in it. */
const under = (path: string[], folder: string[]) => folder.length <= path.length && folder.every((n, i) => path[i] === n);

/** The entries in the folder at `path` of `lib`; none when it is not there. */
const itemsAt = (lib: Entry[], path: string[]) => path.reduce<Entry[]>((items, name) => items.find((e): e is Folder => isFolder(e) && e.folder === name)?.items ?? [], lib);

/** The entry at `path` of `lib`. */
const entryAt = (lib: Entry[], path: string[]) => itemsAt(lib, path.slice(0, -1)).find((e) => entryName(e) === path[path.length - 1]);

/** `lib` with the entries in the folder at `path` changed by `f`. */
const updatedAt = (lib: Entry[], path: string[], f: (items: Entry[]) => Entry[]): Entry[] =>
  path.length ? lib.map((e) => (isFolder(e) && e.folder === path[0] ? { ...e, items: updatedAt(e.items, path.slice(1), f) } : e)) : f(lib);

/** `items` with `incoming` merged in: a folder into the one of the same name, the rest under a free name, " (2)" on. */
function merged(items: Entry[], incoming: Entry[]): Entry[] {
  return incoming.reduce((list, e) => {
    const same = isFolder(e) && list.find((o): o is Folder => isFolder(o) && o.folder === e.folder);
    if (same && isFolder(e)) return list.map((o) => (o === same ? { ...same, items: merged(same.items, e.items) } : o));
    let name = entryName(e);
    for (let k = 2; list.some((o) => entryName(o) === name); k++) name = `${entryName(e)} (${k})`;
    return [...list, isFolder(e) ? { folder: name, items: merged([], e.items) } : { ...e, name }];
  }, items);
}

/** Folders first, then snippets, each by name. */
/** The entries of `items` whose names have `q` in them, ignoring case: a folder with all it holds, else with those in it that do. */
const matching = (items: Entry[], q: string): Entry[] => items.flatMap((e) => {
  if (entryName(e).toLowerCase().includes(q.toLowerCase())) return [e];
  const inner = isFolder(e) ? matching(e.items, q) : [];
  return inner.length ? [{ ...e, items: inner } as Folder] : [];
});

const sortedEntries = (items: Entry[]) => [...items].sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || entryName(a).localeCompare(entryName(b)));

/** A region's label, after the timing that placed its points. */
const regionName = (r: Region) => (isInstance(r) ? `Snippet · ${r.snippet.name}` : isRepeat(r) ? `Repeat · ×${r.repeat.count}` : `Generate · ${r.generate.timing[0].toUpperCase()}${r.generate.timing.slice(1)}`);

/** The selection box's edges, then its corners on top, as the sides dragging them changes. */
const GRIPS = [["from", null], ["to", null], [null, "high"], [null, "low"], ["from", "high"], ["to", "high"], ["from", "low"], ["to", "low"]] as const;
/** How the selection box and the tools' boxes in the graph fill and outline. */
const TOOL_BOX = { fill: "var(--accent-a3)", stroke: "var(--accent-9)" };
/** How a region's band behind the graph fills and outlines, and its label's colour: cyan, an instance's violet, a Repeat one's orange; selected, it outlines as the selected markers. */
const bandOf = (r: Region) => {
  const c = isInstance(r) ? "violet" : isRepeat(r) ? "orange" : "cyan";
  return { fill: `var(--${c}-a3)`, stroke: `var(--${c}-a8)`, label: `var(--${c}-11)` };
};
/** Size of the selection box's grips, in px. */
const GRIP = 8;
/** Least time between a Generate spline's knots, in % of the range. */
const KNOT_GAP = 0.1;
/** Size of the buttons in the selection box that extend it, in px. */
const EXTEND = 24;

/**
 * The advanced editor's document, which the page edits instead of the main
 * script while it is open: its points, in the main script's times, its 0, and
 * the indices of the main script's points it was opened from, null when opened empty;
 * and its regions. In snippet mode, the library snippet it edits, by its
 * folders' and its own name, or null for a new one: Done saves it to the
 * library instead of placing it.
 */
interface Advanced {
  actions: Action[];
  regions: Region[];
  zero: number;
  from: number[] | null;
  snippet?: { path: string[] | null };
  /** Editing an instance, its index in the main script's regions: Done gives one instance of its name. */
  instance?: number;
}

const EMPTY: Script = { name: "untitled", actions: [], chapters: [], bookmarks: [], regions: [] };

/** Copies kept in the clipboard history. */
const HISTORY_SIZE = 10;
/** Edits kept for undo. */
const UNDO_SIZE = 100;

/** Visible time range, in ms; at most the script (the main one too, in the advanced editor), Generate's box or the video, whichever is longer, but at least the floor, room to generate into a blank script. */
const MIN_SPAN = 500;
const MAX_SPAN_FLOOR = 120_000;
/** Steps of the visible time slider, in s; the first that keeps it to about this many steps is used. */
const SPAN_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60];
const SPAN_STEP_COUNT = 240;

/** Height of the time axis below the graph and space above and below the points, in px. */
const AXIS = 20;
const PAD = 10;

const LINE_COLOR = "#ec4899";
/** Below this average spacing between the points in view, in px, the points are not drawn, only the line. */
const DOT_SPACING = 6;
/** A run of up to this many neighbouring selected points in view also shows rings on the points. */
const RING_LIMIT = 50;

/** Width of the graph's left and right edges where a drag scrolls it, in px, and its fastest scroll, in visible times per second. */
const EDGE = 30;
const EDGE_SPEED = 1.5;

/** Height of the minimap that shows the whole script below the graph, in px. */
const MINIMAP_HEIGHT = 40;

/** Least and first height of the view of Generate's Interval or Speed below the graph, in px. */
const TIMING_HEIGHT = 80;

/** Height of the marker lane below the graph, in px. */
const LANE_HEIGHT = 24;
/** How the selected markers show in the lane. */
const SELECTED_MARKER = { outline: "2px solid var(--accent-9)", outlineOffset: -2 };
/** Width of the grips on a chapter's edges in the lane, in px. */
const MARKER_GRIP = 6;
/** Bookmark colours, Radix scales; a bookmark's name picks one, so bookmarks named alike match. */
const MARKER_COLORS = ["blue", "green", "orange", "purple", "cyan", "crimson", "amber", "teal"];
const markerColor = (name: string) => MARKER_COLORS[Math.abs([...name].reduce((h, c) => (h * 31 + c.codePointAt(0)!) | 0, 0)) % MARKER_COLORS.length];

/** Default and smallest height of the reference video, in px. */
const VIDEO_HEIGHT = 300;
const VIDEO_MIN_HEIGHT = 80;
/** Where the playhead stays in view while the video plays, as a fraction of the visible time. */
const FOLLOW_AT = 0.2;
/** Time steps of the seek buttons, in s, as typed; the first is always shown, empty ones are hidden. */
const DEFAULT_STEPS = ["1", "", ""];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const byTime = bisector((a: Action) => a.at).left;
const afterTime = bisector((a: Action) => a.at).right;
/** The speed from `a` to `b`, in depth per second. */
const speed = (a: Action, b: Action) => (Math.abs(b.pos - a.pos) / (b.at - a.at)) * 1000;
const points = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;
/** A typed number; NaN when empty. */
const typed = (v: string) => (v.trim() ? Number(v) : NaN);

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
function scaled(actions: Action[], picked: number[], time: number, low: number, high: number, regions: Region[]): Transformed {
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
function scaleParams(fields: { time: string; out: string; in: string }) {
  const [time, out, inn] = [typed(fields.time), typed(fields.out), typed(fields.in)];
  return time > 0 && out >= 0 && out <= 100 && inn >= 0 && inn <= 100 ? { time, low: 100 - inn, high: 100 - out } : null;
}

/** Shift depth's fields as numbers, typed as depths, as positions: the Offset deeper the higher, Out the limit `max`, In `min`; null while one is refused: limits outside the depths, rather than quietly clamped, or Out past In. */
function shiftParams(fields: { offset: string; out: string; in: string }) {
  const [offset, out, inn] = [typed(fields.offset), typed(fields.out), typed(fields.in)];
  return Number.isFinite(offset) && out >= 0 && inn <= 100 && out <= inn ? { offset: -offset, min: 100 - inn, max: 100 - out } : null;
}

/** Shift the depth of the points `picked` of `actions` by `offset`, then keep it within `min`–`max`. */
function shifted(actions: Action[], picked: number[], offset: number, min: number, max: number): Transformed {
  const hit = new Set(picked);
  return { actions: actions.map((a, i) => (hit.has(i) ? { at: a.at, pos: Math.round(clamp(a.pos + offset, min, max)) } : a)), selected: hit };
}

/**
 * Slow the segments of `actions` touching the points `picked` to `limit`,
 * moving only those points and only one way: with `out` up, else down, each as
 * little as it takes. A pass forward against the point before, then back
 * against the one after; times stay.
 */
function speedLimited(actions: Action[], picked: number[], limit: number, out: boolean): Transformed {
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
function fastestOf(actions: Action[], picked: number[]) {
  const hit = new Set(picked);
  const touched = [...actions.keys()].filter((i) => i > 0 && (hit.has(i) || hit.has(i - 1)));
  return touched.length ? Math.max(...touched.map((i) => speed(actions[i - 1], actions[i]))) : null;
}

/** The shapes a Generate function can take, their names, small graphs (32×16) and fields, in the order shown. */
const SHAPES = {
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
type Shape = keyof typeof SHAPES;
type ShapeField = "value" | "start" | "end" | "min" | "max" | "period" | "phase" | "width" | "seed";
/** The fields that hold a function's values, rather than how it moves between them. */
const SPANNED: readonly ShapeField[] = ["value", "start", "end", "min", "max"];

/** A spline's knots, in time order: their times in % of the range, the first at 0 and the last at 100, and values, for Interval and Speed in % of the way from its Min to its Max. */
type Knots = [number, number][];

/** A Generate function, its fields as typed, but a period and Interval's values in whole ms, typed in s: its shape and that shape's fields; a spline's knots, edited in the graph, as numbers, and for Interval and Speed the Min and Max of its scale. */
type Func = { shape: Shape; knots?: Knots } & Partial<Record<ShapeField, string>>;

/** A new noise seed. */
const newSeed = () => String(Math.floor(Math.random() * 1_000_000));

/** A function's lowest and highest value as typed, a spline's of its knots; 0 and 100 without any. */
function extent(func: Func): [number, number] {
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
function reshaped(func: Func, shape: Shape, own?: number, toward?: number): Func {
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
interface GenerateSetup {
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
type FuncKey = "interval" | "speed" | "out" | "in" | "time";
/** Whether the function `key` is on a scale of its own, in the timing view, rather than in % of the box. */
const ownScale = (key: FuncKey) => key !== "out" && key !== "in";
/** The parts of Generate's setup, shown one at a time, with their handles in the graph: Layout its box, First and the runs on Out and In, Timing its timing and Interval or Speed. */
type GenPart = "position" | "timing" | "out" | "in";

const constant = (value: string): Func => ({ shape: "constant", value });
const GENERATE_DEFAULTS: GenerateSetup = { timing: "interval", first: "in", interval: constant("500"), speed: constant("200"), out: constant("0"), in: constant("100") };

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
function splineAt(knots: Knots, u: number) {
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
function funcAt(func: Func, t: number, span: number) {
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
function generated(setup: GenerateSetup, range: Area, marks: Bookmark[]): Action[] | null {
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
function refilled(actions: Action[], r: Generated, marks: Bookmark[]) {
  const made = markTimes(r.generate, marks).some((t) => t >= r.from && t <= r.to) ? generated(r.generate, r, marks) : [];
  return made ? [...actions.slice(0, byTime(actions, r.from)), ...made, ...actions.slice(afterTime(actions, r.to))] : actions;
}

/**
 * `s` with the bookmarks `bookmarks`: each Markers region, in an instance
 * too, with a bookmark added, gone or renamed in its box puts its points
 * again on the bookmarks, as a rename can change which it skips.
 */
function withBookmarks<T extends Content>(s: T, bookmarks: Bookmark[]): T {
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
interface RepeatSetup {
  count: string;
  time: Func;
  out: Func;
  in: Func;
}

/** What a Repeat region keeps: its setup and its pattern, the points timed from the box's start, the box's Length in whole ms and its lowest and highest position. */
type RepeatKept = RepeatSetup & { pattern: Action[]; length: number; bottom: number; top: number };

const REPEAT_DEFAULTS: RepeatSetup = { count: "4", time: constant("100"), out: constant("0"), in: constant("100") };

/** The shapes that run across a function's range, rather than in time. */
const RANGED: Shape[] = ["ramp", "spline"];

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
function repeated(setup: RepeatSetup, from: number, pattern: Action[], length: number, bottom: number, top: number) {
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
function repeatParams(fields: { length: string; out: string; in: string }) {
  const [length, out, inn] = [Math.round(typed(fields.length) * 1000), typed(fields.out), typed(fields.in)];
  return length > 0 && out >= 0 && out <= inn && inn <= 100 ? { length, bottom: 100 - inn, top: 100 - out } : null;
}

/** Generate's range fields as numbers, its times in ms from shown seconds, Out and In typed as depths, as positions; null while one is refused: times before 0, To before From, or depths outside 0–100 or Out past In. */
function rangeParams(fields: { from: string; to: string; out: string; in: string }, zero: number): Area | null {
  const [from, to] = [Math.round(typed(fields.from) * 1000) + zero, Math.round(typed(fields.to) * 1000) + zero];
  const [out, inn] = [typed(fields.out), typed(fields.in)];
  return from >= 0 && to >= from && out >= 0 && out <= inn && inn <= 100 ? { from, to, low: 100 - inn, high: 100 - out } : null;
}

/** Generate's range fields for `area`, its times in seconds from `zero`, its positions as depths. */
const rangeFields = (area: Area, zero: number) => ({ from: String((area.from - zero) / 1000), to: String((area.to - zero) / 1000), out: String(100 - area.high), in: String(100 - area.low) });

type ToolKind = "scale" | "shift" | "speed" | "generate" | "repeat";

/** The advanced editor's tools: their names, undo labels, and the before and after strokes of their small graphs, 56×24. */
const TOOLS: { kind: ToolKind; name: string; verb: string; before: string; after: string }[] = [
  { kind: "scale", name: "Scale", verb: "Scale", before: "4,16 12,8 20,16 28,8", after: "4,20 20,4 36,20 52,4" },
  { kind: "shift", name: "Shift depth", verb: "Shift depth of", before: "4,20 14,12 24,20 34,12 44,20 52,12", after: "4,12 14,4 24,12 34,4 44,12 52,4" },
  { kind: "speed", name: "Max speed", verb: "Limit speed of", before: "4,20 12,4 20,20 28,4 36,20 44,4 52,20", after: "4,20 12,12 20,20 28,12 36,20 44,12 52,20" },
  // Strokes up to a sine for Out, down to a constant In; the sine faint behind them.
  { kind: "generate", name: "Generate", verb: "Generate", before: "4,8 6,7 8,6 10,5.2 12,4.5 14,4.1 16,4 18,4.1 20,4.5 22,5.2 24,6 26,7 28,8 30,9 32,10 34,10.8 36,11.5 38,11.9 40,12 42,11.9 44,11.5 46,10.8 48,10 50,9 52,8", after: "4,20 8,6 12,20 16,4 20,20 24,6 28,20 32,10 36,20 40,12 44,20 48,10 52,20" },
  // The pattern in pink, then its two copies in grey.
  { kind: "repeat", name: "Repeat", verb: "Repeat", before: "20,20 24,6 28,20 32,12 36,20 40,6 44,20 48,12 52,20", after: "4,20 8,6 12,20 16,12 20,20" },
];

/** A marker time from a file, in ms: ms as a number or `"HH:MM:SS.mmm"`; null when unusable. */
function readTime(t: unknown) {
  const ms = typeof t === "number" ? t : typeof t === "string" && /^\d+(:\d+){0,2}(\.\d+)?$/.test(t) ? t.split(":").reduce((s, p) => s * 60 + Number(p), 0) * 1000 : NaN;
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
}

/** `ms` as `"HH:MM:SS.mmm"`, as markers are saved; the hours go past 24. */
const writeTime = (ms: number) => `${String(Math.floor(ms / 3_600_000)).padStart(2, "0")}:${new Date(ms).toISOString().slice(14, 23)}`;

/**
 * The chapters and bookmarks in `file`'s metadata, sorted. A chapter without an
 * end runs to the next one's start, the last to `end`; overlapping chapters are
 * cut where the later one starts.
 */
function readMarkers(file: Record<string, unknown>, end: number) {
  const meta = (file.metadata ?? {}) as { chapters?: unknown; bookmarks?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((o): o is Record<string, unknown> => !!o && typeof o === "object") : []);
  const starts = list(meta.chapters)
    .map(({ startTime, endTime, ...rest }) => ({ rest, start: readTime(startTime), end: readTime(endTime) }))
    .filter((c): c is typeof c & { start: number } => c.start !== null)
    .sort((a, b) => a.start - b.start);
  const chapters: Chapter[] = starts
    .map((c, i) => {
      const next = starts[i + 1]?.start;
      const stop = c.end !== null && c.end > c.start ? c.end : next ?? Math.max(end, c.start + 1);
      return { ...c.rest, name: typeof c.rest.name === "string" ? c.rest.name : `Chapter ${i + 1}`, start: c.start, end: Math.min(stop, next ?? Infinity) };
    })
    .filter((c) => c.end > c.start);
  const bookmarks: Bookmark[] = list(meta.bookmarks)
    .map(({ time, ...rest }) => ({ ...rest, name: (typeof rest.name === "string" && rest.name) || "Marker", time: readTime(time) }))
    .filter((b): b is Bookmark => b.time !== null)
    .sort((a, b) => a.time - b.time);
  return { chapters, bookmarks };
}

/**
 * The regions in `list`, from a file's or the clipboard's `"ossmRsWebTools"`, sorted.
 * Lenient: one is left out, its points staying ordinary, when its times are
 * not numbers with From before To, or it has neither a setup that is an
 * object with a known timing and known shapes, a spline's with knots, a
 * Repeat setup with a pattern of two points or more, a Length and known
 * shapes, nor a snippet with a name; of overlapping ones, all but the first. An instance's
 * regions are read alike, those not inside it left out alone. Field values
 * are not checked.
 */
function readRegions(list: unknown): Region[] {
  const known = (f?: Func) => !!f && typeof f === "object" && Object.keys(SHAPES).includes(f.shape) && (f.shape !== "spline" || Array.isArray(f.knots));
  const read = (Array.isArray(list) ? list : []).flatMap((r): Region[] => {
    if (typeof r?.from !== "number" || typeof r.to !== "number" || !(r.from < r.to)) return [];
    const g = r.generate as GenerateSetup | undefined;
    if (!!g && typeof g === "object" && ["interval", "speed", "markers"].includes(g.timing) && known(g.interval) && known(g.speed) && known(g.out) && known(g.in)) return [r];
    const p = r.repeat as RepeatKept | undefined;
    const pattern = Array.isArray(p?.pattern) && p.pattern.every((a) => Number.isFinite(a?.at) && Number.isFinite(a?.pos)) ? p.pattern : [];
    if (pattern.length > 1 && typeof p?.length === "number" && known(p.time) && known(p.out) && known(p.in)) return [r];
    const snippet = r.snippet as { name?: unknown; regions?: unknown } | undefined;
    if (typeof snippet?.name !== "string") return [];
    // Not nested: an instance's own instances go.
    const inner = readRegions(snippet.regions).filter((i): i is Inner => !isInstance(i) && i.from >= r.from && i.to <= r.to);
    return [{ ...r, snippet: { ...snippet, name: snippet.name, regions: inner } }];
  });
  const regions: Region[] = [];
  for (const r of read.sort((a, b) => a.from - b.from)) if (!regions.length || r.from > regions[regions.length - 1].to) regions.push(r);
  return regions;
}

/**
 * Points from the clipboard or a file, with the regions they carry, timed
 * from the first point; null without any. Anything could be in them: points
 * without numbers go, the rest are sorted, in whole ms, one per ms, within
 * 0–100; the regions are read as `readRegions` does.
 */
function readClip(actions: unknown, regions: unknown): Clip | null {
  if (!Array.isArray(actions)) return null;
  const valid = (actions as Partial<Action>[])
    .filter((a): a is Action => Number.isFinite(a?.at) && Number.isFinite(a?.pos))
    .sort((a, b) => a.at - b.at);
  if (!valid.length) return null;
  return {
    actions: valid
      .map((a) => ({ at: Math.round(a.at - valid[0].at), pos: clamp(a.pos, 0, 100) }))
      .filter((a, i, all) => i === 0 || a.at !== all[i - 1].at),
    regions: readRegions(regions).map((r) => movedBy(r, -valid[0].at)),
  };
}

/** The snippet library's entries in `list`, from an imported file; malformed ones go: without a name, or a snippet without two points. */
function readEntries(list: unknown): Entry[] {
  return (Array.isArray(list) ? list : []).flatMap((e): Entry[] => {
    if (typeof e?.folder === "string" && e.folder.trim() && Array.isArray(e.items)) return [{ folder: e.folder, items: readEntries(e.items) }];
    const clip = typeof e?.name === "string" && e.name.trim() ? readClip(e.actions, e.regions) : null;
    // Its instances' contents only, as instances do not nest.
    return clip && clip.actions.length > 1 ? [{ name: e.name, actions: clip.actions, regions: generators(clip.regions) }] : [];
  });
}

/** Download `json` as the file `name`. */
function download(json: string, name: string) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([json], { type: "application/json" })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

export default function EditorPage() {
  // Kept across reloads, so switching tabs or closing the page does not lose the work.
  const [main, setMain] = usePersistedState<Script>("ossm:editorScript", EMPTY, localStorage);
  /** The advanced editor's document while it is open; kept across reloads too. */
  const [advanced, setAdvanced] = usePersistedState<Advanced | null>("ossm:editorAdvanced", null, localStorage);
  /** The script the page shows and edits: the main one, or with the advanced editor's points and regions while it is open, which take only changes to those. */
  const script = advanced ? { ...main, actions: advanced.actions, regions: advanced.regions } : main;
  const setScript: typeof setMain = (next) => {
    if (!advanced) return setMain(next);
    setAdvanced((d) => {
      if (!d) return d;
      const { actions, regions } = next instanceof Function ? next({ ...main, actions: d.actions, regions: d.regions }) : next;
      return { ...d, actions, regions };
    });
  };
  /**
   * The advanced editor's open tool, with the points and affected indices it
   * was opened on, and their fastest segment; its result shows until applied.
   * Generate on a `region`, in the main script too, edits it in place.
   */
  const [tool, setTool] = useState<{ kind: ToolKind; actions: Action[]; picked: number[]; fastest: number | null; region?: Inner } | null>(null);
  /** The Snippets panel shows beside the graph, in the main script and the advanced editor alike. */
  /** The panel beside the graph, on its other side from the sidebar, and which it shows: the markers list or the snippet library. */
  const [asideShown, setAsideShown] = usePersistedState("ossm:editorAsideShown", true, localStorage);
  const [asideTab, setAsideTab] = usePersistedState<"markers" | "snippets">("ossm:editorAsideTab", "snippets", localStorage);
  /** The snippet library, shared by all scripts, as its file holds it. */
  const [libraryFile, setLibraryFile] = usePersistedState<LibraryFile>("ossm:editorSnippets", { ossmRsWebTools: { version: 1, snippets: [] } }, localStorage);
  const library = libraryFile.ossmRsWebTools.snippets;
  const setLibrary = (f: (lib: Entry[]) => Entry[]) => setLibraryFile((l) => ({ ossmRsWebTools: { version: 1, snippets: f(l.ossmRsWebTools.snippets) } }));
  /** The library's open folders, by their paths as JSON. */
  const [openFolders, setOpenFolders] = usePersistedState<string[]>("ossm:editorSnippetFolders", [], localStorage);
  /** Only the library's entries with this in their names show, their folders open. */
  const [snippetQuery, setSnippetQuery] = useState("");
  /**
   * The library row being dragged, by its path, with the pointer, and the
   * folder it would go into, by its path as JSON. Pointer events, not native
   * drag and drop, so Shift and Ctrl still work over the graph (Wayland
   * browsers don't report them during a native drag).
   */
  const [rowDrag, setRowDrag] = useState<{ at: string[]; x: number; y: number } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const libraryInput = useRef<HTMLInputElement>(null);
  const [view, setView] = usePersistedState("ossm:editorView", { from: 0, span: 10_000 });
  /** The view for drags, which read it between renders as they scroll it. */
  const viewRef = useRef(view);
  viewRef.current = view;
  /** The points for drags, which read them between renders. */
  const actionsRef = useRef(script.actions);
  actionsRef.current = script.actions;
  const [error, setError] = useState<string | null>(null);
  /** Indices of the selected points, moved together and deleted with the Delete key. */
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  /** The selected markers, moved, renamed and deleted together: a chapter, or bookmarks; one or the other, selecting points clears them. */
  const [marked, setMarked] = useState<Set<Marker>>(() => new Set());
  useEffect(() => {
    if (selected.size) setMarked(new Set());
  }, [selected]);
  /** The selected region, one at a time; selecting points or markers clears it. */
  const [regionOn, setRegionOn] = useState<Region | null>(null);
  /** While a region is dragged, the ordinary points it would replace, shown faded; they go when it is released. */
  const [covered, setCovered] = useState<Action[]>([]);
  /** A dragged region while it is over another, out of the script and shown red, with its points. */
  const [astray, setAstray] = useState<Clip | null>(null);
  useEffect(() => {
    if (selected.size || marked.size) setRegionOn(null);
  }, [selected, marked]);
  /** The marker last clicked without Shift, where a Shift+click range of bookmarks starts. */
  const markerAnchor = useRef<Marker | null>(null);
  /** Whether the pointer is over the marker lane, where Ctrl/Cmd+A selects all bookmarks. */
  const overLane = useRef(false);
  /** What a new bookmark is called: the name last given to one, for this visit to the page. */
  const [lastName, setLastName] = useState("Marker");
  /**
   * The name field open over the time from `from` to `to` in the marker lane;
   * `done` gets the accepted name, or null to keep the old one. With `remove`,
   * it has a Delete button.
   */
  const [naming, setNaming] = useState<{ from: number; to: number; name: string; done: (name: string | null) => void; remove?: () => void } | null>(null);
  /** The time under the pointer over the graph or the marker lane, where B adds a bookmark without media. */
  const hoverAt = useRef<number | null>(null);
  /** The marker last pressed and when, to tell a double-click: the drag's pointer capture keeps the browser's own from reaching the marker. */
  const lastPress = useRef<{ m: Marker; at: number } | null>(null);
  /**
   * Selection mode: dragging on empty space draws a box that selects points
   * instead of adding one, and the box stays to be resized or moved; only the
   * points in it are selected. Otherwise Shift draws one that goes when released.
   */
  const [boxMode, setBoxMode] = useState(false);
  /** Asking whether to apply or discard the advanced editor's changes, on leaving it by its toolbox button. */
  const [leaving, setLeaving] = useState(false);
  /** Pasted points, timed from the first, with the regions they carry, that follow the pointer until a click places them. */
  const [placing, setPlacing] = useState<Clip | null>(null);
  /** In Move mode, the selected points being placed again, left out of the script until placed; Escape puts them back. None for the advanced editor's result when it was opened empty. */
  const [lifted, setLifted] = useState<Set<number> | null>(null);
  /** In Move mode, the instance being placed again with the lifted points, left out of the script with them. */
  const [liftedRegion, setLiftedRegion] = useState<Region | null>(null);
  /** Where the first point being placed is, under the pointer. */
  const [placeAt, setPlaceAt] = useState<Action | null>(null);
  /** Placing inserts, moving later points right, instead of replacing the points the pasted ones cover. */
  const [insertMode, setInsertMode] = usePersistedState("ossm:editorInsert", false, localStorage);
  /** Selection mode's box selects by time: it takes in whole stretches of the script, whatever their depth. */
  const [selectByTime, setSelectByTime] = usePersistedState("ossm:editorSelectByTime", false, localStorage);
  /** Moving takes out the time the selection spanned, so moving and inserting keeps the script's length. */
  const [closeGap, setCloseGap] = usePersistedState("ossm:editorCloseGap", false, localStorage);
  /**
   * Modifiers held while placing: Shift switches to the other mode, Ctrl (or
   * Cmd) keeps the copied depths instead of following the pointer's.
   */
  const [held, setHeld] = useState({ shift: false, ctrl: false });
  const inserting = insertMode !== held.shift;
  /** The latest copies, newest first; for this visit to the page. */
  const [history, setHistory] = useState<Clip[]>([]);
  /** The selection box, with the points it was drawn on; it goes when they change. */
  const [boxOn, setBoxOn] = useState<{ area: Area; actions: Action[] } | null>(null);
  const box = boxOn?.actions === script.actions ? boxOn.area : null;
  const setBox = (area: Area | null, on = script.actions) => setBoxOn(area && { area, actions: on });
  /** The point last clicked without Shift, where a Shift+click range starts. */
  const anchor = useRef<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** The graph and the marker lane, which scroll and zoom alike. */
  const timeRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Re-rendered on a theme change, so the canvas picks up its colours. Radix's own context, as the theme's colours change a render after the app's appearance does.
  useThemeContext();
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const videoInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLMediaElement>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  /** An audio file plays in a bar instead of the video area. */
  const isAudio = !!videoFile?.type.startsWith("audio/");
  /** Separate from the player's sizes. */
  const [normalHeight, setNormalHeight] = usePersistedState("ossm:editorVideoHeight", VIDEO_HEIGHT, localStorage);
  /** The video left in the page while it plays picture-in-picture has a height of its own. */
  const [pipHeight, setPipHeight] = usePersistedState("ossm:editorVideoPipHeight", VIDEO_MIN_HEIGHT, localStorage);
  const [paused, setPaused] = useState(true);
  const [pip, setPip] = useState(false);
  /** Hidden, the video or audio and its controls leave their room to the graph. */
  const [playerShown, setPlayerShown] = useState(true);
  /** Hide the player, pausing it, or show it. */
  const togglePlayer = () => {
    if (playerShown) videoRef.current?.pause();
    setPlayerShown(!playerShown);
  };
  const [videoHeight, setVideoHeight] = pip ? [pipHeight, setPipHeight] : [normalHeight, setNormalHeight];
  /** A minimap of the whole script to scroll with, instead of the slider. */
  const [minimap, setMinimap] = usePersistedState("ossm:editorMinimap", true, localStorage);
  /** The advanced editor shows times from its 0, earlier ones negative; only as shown, the points keep the main script's times. */
  const [fromZero, setFromZero] = usePersistedState("ossm:editorFromZero", false, localStorage);
  /** In the advanced editor, points are added and dragged onto the nearest bookmark's time; only with bookmarks. */
  const [onMarkers, setOnMarkers] = usePersistedState("ossm:editorOnMarkers", false, localStorage);
  useEffect(() => {
    if (!script.bookmarks.length) setOnMarkers(false);
  }, [script.bookmarks.length, setOnMarkers]);
  /** The time shown as 0. */
  const zero = advanced && fromZero ? advanced.zero : 0;
  const [steps, setSteps] = usePersistedState("ossm:editorSteps", DEFAULT_STEPS, localStorage);
  /** The steps in use; a first step that is not a positive number falls back to the default. */
  const shownSteps = steps.map(Number).map((v, i) => (v > 0 ? v : i === 0 ? Number(DEFAULT_STEPS[0]) : null)).filter((v) => v !== null);
  /** Video time, in ms. */
  const [time, setTime] = useState(0);
  /** Video length, in ms; 0 without one. */
  const [videoDuration, setVideoDuration] = useState(0);
  const end = script.actions.length ? script.actions[script.actions.length - 1].at : 0;

  useEffect(() => {
    setVideoUrl(null);
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  // Picture-in-picture events bubble, so the document sees them for whichever video is shown.
  useEffect(() => {
    const update = () => setPip(!!document.pictureInPictureElement);
    document.addEventListener("enterpictureinpicture", update);
    document.addEventListener("leavepictureinpicture", update);
    return () => {
      document.removeEventListener("enterpictureinpicture", update);
      document.removeEventListener("leavepictureinpicture", update);
    };
  }, []);

  // While the video plays, the playhead moves every frame and the graph follows it.
  useEffect(() => {
    if (paused) return;
    let frame = requestAnimationFrame(function tick() {
      const t = (videoRef.current?.currentTime ?? 0) * 1000;
      setTime(t);
      setView((v) => ({ ...v, from: Math.max(t - v.span * FOLLOW_AT, 0) }));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [paused, setView]);

  /** Seeking while paused brings the playhead into view. */
  const seeked = () => {
    const t = (videoRef.current?.currentTime ?? 0) * 1000;
    setTime(t);
    setView((v) => (t < v.from || t > v.from + v.span ? { ...v, from: Math.max(t - v.span * FOLLOW_AT, 0) } : v));
  };

  /** Drag the bottom of something `start` px high to resize it, or its top if `top`, from `min` px to 70% of the window. */
  const dragHeight = (e: PointerEvent<HTMLElement>, start: number, set: (h: number) => void, min: number, top = false) => {
    e.preventDefault();
    const target = e.currentTarget;
    const startY = e.clientY;
    const move = (m: globalThis.PointerEvent) =>
      set(Math.round(Math.min(Math.max(start + (top ? startY - m.clientY : m.clientY - startY), min), window.innerHeight * 0.7)));
    target.setPointerCapture(e.pointerId);
    target.addEventListener("pointermove", move);
    target.addEventListener("lostpointercapture", () => target.removeEventListener("pointermove", move), { once: true });
  };
  /** Drag the bottom edge of the video to set its height; at most most of the window. */
  const dragVideoHeight = (e: PointerEvent<HTMLElement>) => dragHeight(e, videoHeight, setVideoHeight, VIDEO_MIN_HEIGHT);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(boxRef.current!);
    return () => observer.disconnect();
  }, []);

  const { actions, chapters, bookmarks, regions } = script;
  /** The selected region while it is in the script; it goes with an edit that replaces it. */
  const region = regionOn && regions.includes(regionOn) ? regionOn : null;
  /** Whether there is something to copy: selected points, or a selected region with points. */
  const copyable = selected.size > 0 || (!!region && afterTime(actions, region.to) > byTime(actions, region.from));
  /** While the advanced editor is open, the main script's other points, in runs broken where its points were taken out; drawn faintly behind them, never edited. */
  const context = useMemo(() => {
    if (!advanced) return [];
    const from = new Set(advanced.from);
    const runs: Action[][] = [[]];
    main.actions.forEach((a, i) => (from.has(i) ? runs[runs.length - 1].length && runs.push([]) : runs[runs.length - 1].push(a)));
    return runs.filter((run) => run.length);
  }, [main.actions, advanced?.from]);
  /** The regions that stay while placing, with `kept`'s points, but a lifted instance: closing the gap, those in it go with their points, and later ones move left as theirs do. */
  const keptRegions = useMemo(() => {
    const rest = lifted ? regions.filter((r) => r !== liftedRegion) : regions;
    if (!lifted?.size || !closeGap) return rest;
    const [lo, hi] = [actions[Math.min(...lifted)].at, actions[Math.max(...lifted)].at];
    return rest.filter((r) => r.to < lo || r.from > hi).map((r) => (r.from > hi ? movedBy(r, lo - hi) : r));
  }, [regions, actions, lifted, liftedRegion, closeGap]);
  /**
   * The points that stay while placing. Closing the gap, the time from the
   * first to the last lifted point goes, with any other points in it, and the
   * later points move left by as much, as do the regions after it, those in
   * it going with their points; inserting them back there undoes it. A moved
   * Markers region's points go on the bookmarks in its new box.
   */
  const kept = useMemo(() => {
    if (!lifted) return actions;
    if (!closeGap || !lifted.size) return actions.filter((_, i) => !lifted.has(i));
    const [lo, hi] = [Math.min(...lifted), Math.max(...lifted)];
    const span = actions[hi].at - actions[lo].at;
    const closed = [...actions.slice(0, lo), ...actions.slice(hi + 1).map((a) => ({ at: a.at - span, pos: a.pos }))];
    const shifted = span ? markersRegions(keptRegions).filter((r) => r.from > actions[lo].at) : [];
    return shifted.reduce((list, r) => refilled(list, r, bookmarks), closed);
  }, [actions, lifted, closeGap, keptRegions, bookmarks]);

  /** Undo history: the points, markers and regions after each edit, the first as loaded; `index` is the current one. */
  const [timeline, setTimeline] = useState(() => ({ states: [{ actions, chapters, bookmarks, regions, label: advanced ? "Open" : "Start" }], index: 0 }));
  /** The main script's undo history, put aside while the advanced editor is open; lost on a reload, when it starts over. */
  const mainTimeline = useRef<typeof timeline | null>(null);
  /** Set while a drag runs, so the whole drag becomes one edit when it ends. */
  const dragging = useRef(false);
  const [dragEnds, setDragEnds] = useState(0);
  /** What the next edit is called in the undo history. */
  const editLabel = useRef<string | null>(null);

  // Every change of the points, markers or regions, except by undo and redo, is an edit.
  useEffect(() => {
    if (dragging.current) return;
    const label = editLabel.current ?? "Edit";
    editLabel.current = null;
    setTimeline((tl) => {
      if (sameContent(tl.states[tl.index], script)) return tl;
      const states = [...tl.states.slice(0, tl.index + 1), { actions, chapters, bookmarks, regions, label }].slice(-UNDO_SIZE - 1);
      return { states, index: states.length - 1 };
    });
  }, [actions, chapters, bookmarks, regions, dragEnds]);

  /** Go to the points, markers and regions after edit `index` of the undo history. */
  const jump = (index: number) => {
    const { actions, chapters, bookmarks, regions } = timeline.states[index];
    setTimeline((tl) => ({ ...tl, index }));
    setTool(null);
    setScript((s) => ({ ...s, actions, chapters, bookmarks, regions }));
    setSelected(new Set());
    setMarked(new Set());
    setRegionOn(null);
    setBox(null);
    setPlacing(null);
    setLifted(null);
  };
  /** The points and markers as last saved, opened or started anew; unknown after a reload with unsaved changes. */
  const [unsaved, setUnsaved] = usePersistedState("ossm:editorUnsaved", false, localStorage);
  const [saved, setSaved] = useState<Content | null>(() => (unsaved ? null : main));
  const changed = !saved || !sameContent(saved, main);
  useEffect(() => setUnsaved(changed), [changed, setUnsaved]);
  useWindowEvent("beforeunload", (e) => {
    if (changed) e.preventDefault();
  });
  const canUndo = timeline.index > 0;
  const canRedo = timeline.index < timeline.states.length - 1;
  // With a tool open, they discard it first.
  const undo = () => (tool ? setTool(null) : canUndo && jump(timeline.index - 1));
  const redo = () => (tool ? setTool(null) : canRedo && jump(timeline.index + 1));
  const plotHeight = height - AXIS;
  const x = (at: number) => ((at - view.from) / view.span) * width;
  const y = (pos: number) => PAD + (1 - pos / 100) * (plotHeight - 2 * PAD);
  /** The script time and position under the pointer. */
  const pointerAt = (e: { clientX: number; clientY: number }) => {
    const rect = boxRef.current!.getBoundingClientRect();
    const { from, span } = viewRef.current;
    return {
      at: Math.round(from + ((e.clientX - rect.left) / width) * span),
      pos: Math.round(clamp(100 - ((e.clientY - rect.top - PAD) / (plotHeight - 2 * PAD)) * 100, 0, 100)),
    };
  };

  /**
   * Follow a drag from `e` on `target` with `move`, then `end`. Held at the
   * graph's left or right edge, or past it, the graph scrolls that way, faster
   * the further out, and `move` follows; only once the drag has been away from
   * the edges, so a press near one does not scroll, and while `scrolls` allows
   * it in that direction (1 right, -1 left) with the pointer at `m`.
   */
  const track = (
    target: Element,
    e: PointerEvent<Element>,
    move: (m: globalThis.PointerEvent) => void,
    end?: () => void,
    scrolls?: (dir: number, m: globalThis.PointerEvent) => boolean,
  ) => {
    let last: globalThis.PointerEvent | null = null;
    let armed = false;
    let before = performance.now();
    const pushed = (m: { clientX: number }) => {
      const rect = boxRef.current!.getBoundingClientRect();
      const px = m.clientX - rect.left;
      return clamp(px < EDGE ? (px - EDGE) / EDGE : px > rect.width - EDGE ? (px - rect.width + EDGE) / EDGE : 0, -1, 1);
    };
    let frame = requestAnimationFrame(function scroll(now) {
      const v = viewRef.current;
      const push = last && armed ? pushed(last) : 0;
      const from = Math.max(v.from + (push && (scrolls?.(Math.sign(push), last!) ?? true) ? push : 0) * EDGE_SPEED * v.span * ((now - before) / 1000), 0);
      before = now;
      if (from !== v.from) {
        setView((viewRef.current = { ...v, from }));
        move(last!);
      }
      frame = requestAnimationFrame(scroll);
    });
    const moved = (m: globalThis.PointerEvent) => {
      last = m;
      armed ||= !pushed(m);
      move(m);
    };
    target.setPointerCapture(e.pointerId);
    target.addEventListener("pointermove", moved as EventListener);
    target.addEventListener("lostpointercapture", () => {
      target.removeEventListener("pointermove", moved as EventListener);
      cancelAnimationFrame(frame);
      end?.();
    }, { once: true });
  };

  /**
   * Drag the points `indices` together. They keep their spacing, stay within
   * 0–100 and between their unselected neighbours, so the actions stay sorted,
   * and out of the regions. Placing points on markers, the grabbed one goes to
   * the bookmark nearest the pointer instead, of those that keep them all from
   * 0 on and out of the regions, and they may pass other points; on release, a
   * point left at a dragged one's time goes.
   */
  const drag = (e: PointerEvent<Element>, indices: number[]) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = e.currentTarget.closest("svg")!;
    dragging.current = true;
    editLabel.current ??= `Move ${points(indices.length)}`;
    const origin = pointerAt(e);
    const moving = new Set(indices);
    // Taken on the first move, so it includes a point added just before the drag.
    let start: Action[] | null = null;
    /** How far in time they can go, from where they started; known from the first move. */
    let limits: [number, number] | null = null;
    /** Snapped, the points in order as last shown, the dragged ones marked. */
    let placed: { action: Action; moved: boolean }[] | null = null;
    const show = (list: { action: Action; moved: boolean }[]) => {
      placed = list;
      setScript((s) => ({ ...s, actions: list.map((x) => x.action) }));
      setSelected(new Set(list.flatMap((x, j) => (x.moved ? [j] : []))));
    };
    const move = (m: globalThis.PointerEvent) => {
      const p = pointerAt(m);
      if (advanced && onMarkers) {
        // A render has run since the press, so this has a point added just before.
        const a = (start ??= actionsRef.current);
        const grabbed = indices.reduce((g, i) => (Math.abs(a[i].at - origin.at) < Math.abs(a[g].at - origin.at) ? i : g));
        const fits = bookmarks.filter((b) => indices.every((i) => a[i].at + b.time - a[grabbed].at >= 0 && !regionAt(regions, a[i].at + b.time - a[grabbed].at)));
        if (!fits.length) return;
        const dt = fits.reduce((n, b) => (Math.abs(b.time - p.at) < Math.abs(n.time - p.at) ? b : n)).time - a[grabbed].at;
        const dp = clamp(p.pos - origin.pos, Math.max(...indices.map((i) => -a[i].pos)), Math.min(...indices.map((i) => 100 - a[i].pos)));
        const moved = indices.map((i) => ({ action: { at: a[i].at + dt, pos: a[i].pos + dp }, moved: true }));
        const kept = a.filter((_, i) => !moving.has(i)).map((action) => ({ action, moved: false }));
        return show([...kept, ...moved].sort((x, y) => x.action.at - y.action.at));
      }
      setScript((s) => {
        const a = (start ??= s.actions);
        let [dtMin, dtMax, dpMin, dpMax] = [-Infinity, Infinity, -100, 100];
        for (const i of indices) {
          dtMin = Math.max(dtMin, -a[i].at, i > 0 && !moving.has(i - 1) ? a[i - 1].at + 1 - a[i].at : -Infinity);
          dtMax = Math.min(dtMax, i < a.length - 1 && !moving.has(i + 1) ? a[i + 1].at - 1 - a[i].at : Infinity);
          dpMin = Math.max(dpMin, -a[i].pos);
          dpMax = Math.min(dpMax, 100 - a[i].pos);
          for (const r of regions) {
            if (r.from > a[i].at) dtMax = Math.min(dtMax, r.from - 1 - a[i].at);
            if (r.to < a[i].at) dtMin = Math.max(dtMin, r.to + 1 - a[i].at);
          }
        }
        limits = [dtMin, dtMax];
        const dt = clamp(p.at - origin.at, dtMin, dtMax);
        const dp = clamp(p.pos - origin.pos, dpMin, dpMax);
        const next = a.slice();
        for (const i of indices) next[i] = { at: a[i].at + dt, pos: a[i].pos + dp };
        return { ...s, actions: next };
      });
    };
    // Scrolling stops where they can go no further that way.
    const scrolls = (dir: number, m: globalThis.PointerEvent) => {
      const dt = pointerAt(m).at - origin.at;
      return !limits || (dir > 0 ? dt < limits[1] : dt > limits[0]);
    };
    track(svg, e, move, () => {
      if (placed) {
        const taken = new Set(placed.filter((x) => x.moved).map((x) => x.action.at));
        show(placed.filter((x) => x.moved || !taken.has(x.action.at)));
        anchor.current = null;
      }
      dragging.current = false;
      setDragEnds((n) => n + 1);
    }, scrolls);
  };

  /** The indices of the points in `area`, but the regions' points, which are never selected. */
  const within = (area: Area) => {
    const found = [];
    for (let i = byTime(actions, area.from); i < actions.length && actions[i].at <= area.to; i++) {
      if (actions[i].pos >= area.low && actions[i].pos <= area.high && !regionAt(regions, actions[i].at)) found.push(i);
    }
    return found;
  };

  /** Show `area` as the selection box and select the points in it and `base`. */
  const selectIn = (area: Area, base: Iterable<number> = []) => {
    setBox(area);
    setSelected(new Set([...base, ...within(area)]));
  };

  /** `area` as selection mode's box, over every depth when selecting by time. */
  const boxed = (area: Area) => (selectByTime ? { ...area, low: 0, high: 100 } : area);

  /**
   * Draw a box from the pointer and select the points in it. In selection mode
   * the box replaces the selection and stays; otherwise (with Shift) the points
   * add to it and the box goes when released. A click without dragging clears
   * the selection.
   */
  const boxSelect = (e: PointerEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = e.currentTarget;
    const keep = boxMode;
    const base = keep ? [] : selected;
    const origin = pointerAt(e);
    const [x0, y0] = [e.clientX, e.clientY];
    let moved = false;
    const move = (m: globalThis.PointerEvent) => {
      moved ||= Math.hypot(m.clientX - x0, m.clientY - y0) > 3;
      if (!moved) return;
      const area = spanned(origin, pointerAt(m));
      selectIn(keep ? boxed(area) : area, base);
    };
    track(svg, e, move, () => {
      if (!moved || !keep) setBox(null);
      if (!moved) setSelected(new Set());
    });
  };

  /**
   * Drag the `sides` of the selection box: an edge or corner resizes it, all
   * four move it. Only the points in it are selected.
   */
  const editBox = (e: PointerEvent<SVGRectElement>, sides: (keyof Area)[]) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = e.currentTarget.ownerSVGElement!;
    const start = box!;
    const origin = pointerAt(e);
    const move = (m: globalThis.PointerEvent) => {
      const p = pointerAt(m);
      // Moved, the box stays within 0–100.
      const dp = clamp(p.pos - origin.pos, sides.includes("low") ? -start.low : -100, sides.includes("high") ? 100 - start.high : 100);
      const b = { ...start };
      for (const side of sides) b[side] += side === "from" || side === "to" ? p.at - origin.at : dp;
      selectIn(spanned({ at: b.from, pos: b.low }, { at: b.to, pos: b.high }));
    };
    track(svg, e, move);
  };

  /**
   * Add a point under the pointer and keep dragging it; in a region, select
   * it instead, and drag it; with several points selected, only clear the selection.
   * Placing on markers, it goes at the time of the nearest bookmark outside
   * the regions and is dragged along them.
   */
  const add = (e: PointerEvent<SVGSVGElement>) => {
    if (tool) return;
    const hit = pointUnder(e);
    if (hit !== null) return pointDown(e, hit);
    if (e.button !== 0) return;
    if (boxMode || e.shiftKey) {
      boxSelect(e);
      return;
    }
    const point = pointerAt(e);
    const inside = regionAt(regions, point.at);
    if (inside) {
      selectRegion(inside);
      dragRegion(e, inside);
      return;
    }
    if (selected.size > 1) {
      setSelected(new Set());
      return;
    }
    if (advanced && onMarkers) {
      const free = bookmarks.filter((b) => !regionAt(regions, b.time));
      if (!free.length) return;
      point.at = free.reduce((a, b) => (Math.abs(b.time - point.at) < Math.abs(a.time - point.at) ? b : a)).time;
    }
    if (point.at < 0) return;
    const i = byTime(actions, point.at);
    if (actions[i]?.at === point.at) return;
    editLabel.current = "Add point";
    setScript((s) => ({ ...s, actions: [...s.actions.slice(0, i), point, ...s.actions.slice(i)] }));
    setSelected(new Set([i]));
    anchor.current = i;
    drag(e, [i]);
  };

  /**
   * Drag the region `r` in time with its points, its depth staying, from 0 on,
   * a Markers one's, also in an instance, going on the bookmarks in its box;
   * the ordinary points it covers go. It passes other regions: over one, it
   * goes against the edge of a covered one nearest the pointer, the nearest
   * of those in view where it is free; with none, it shows red where it is,
   * out of the script, and released there it goes back to where it started.
   */
  const dragRegion = (e: PointerEvent<SVGSVGElement>, r: Region) => {
    const svg = e.currentTarget;
    const own = actions.slice(byTime(actions, r.from), afterTime(actions, r.to));
    const rest = actions.filter((a) => a.at < r.from || a.at > r.to);
    const others = regions.filter((o) => o !== r);
    const [origin, x0] = [pointerAt(e).at, e.clientX];
    let moved = false;
    /** Whether it is over another region, out of the script. */
    let over = false;
    /** Its points with it moved to `to`, `dt` from where it started: a Markers one's, or an instance's Markers regions', on the bookmarks there. */
    const pointsAt = (to: Region, dt: number) => {
      const shifted = own.map((a) => ({ at: a.at + dt, pos: a.pos }));
      return markersRegions([to]).reduce((list, g) => refilled(list, g, bookmarks), shifted);
    };
    /** Put it `dt` from where it started; back there, the script as it was. */
    const land = (dt: number) => {
      const to = dt ? movedBy(r, dt) : r;
      const under = (a: Action) => a.at >= to.from && a.at <= to.to;
      const left = rest.filter((a) => !under(a));
      const i = byTime(left, to.from);
      setCovered(rest.filter(under));
      setScript((s) => ({
        ...s,
        actions: dt ? [...left.slice(0, i), ...pointsAt(to, dt), ...left.slice(i)] : actions,
        regions: dt ? [...others, to].sort((a, b) => a.from - b.from) : regions,
      }));
      setRegionOn(to);
    };
    dragging.current = true;
    const move = (m: globalThis.PointerEvent) => {
      moved ||= Math.abs(m.clientX - x0) > 3;
      if (!moved) return;
      const p = pointerAt(m).at;
      const dt = Math.max(p - origin, -r.from);
      const to = movedBy(r, dt);
      const free = (t: Region) => t.from >= 0 && !others.some((o) => o.from <= t.to && o.to >= t.from);
      editLabel.current = `Move ${regionNoun(r)}`;
      if (free(to)) {
        over = false;
        setAstray(null);
        return land(dt);
      }
      // The covered regions' edges, nearest the pointer first, with how far it moves to be just past each; the first out of view stops the search.
      const { from, span } = viewRef.current;
      const seen = (t: number) => t >= from && t <= from + span;
      const spot = others
        .filter((o) => o.from <= to.to && o.to >= to.from)
        .flatMap((o) => [[o.from, o.from - 1 - r.to], [o.to, o.to + 1 - r.from]])
        .sort(([a], [b]) => Math.abs(a - p) - Math.abs(b - p))
        .find(([t, d]) => !seen(t) || free(movedBy(r, d)));
      over = !spot || !seen(spot[0]);
      setAstray(over ? { actions: pointsAt(to, dt), regions: [to] } : null);
      if (!over) return land(spot![1]);
      setCovered([]);
      setScript((s) => ({ ...s, actions: rest, regions: others }));
    };
    // Scrolling stops at 0.
    const scrolls = (dir: number, m: globalThis.PointerEvent) => dir > 0 || pointerAt(m).at - origin > -r.from;
    track(svg, e, move, () => {
      if (over) land(0);
      setAstray(null);
      setCovered([]);
      dragging.current = false;
      setDragEnds((n) => n + 1);
    }, scrolls);
  };

  /**
   * Ctrl/Cmd+click toggles a point in the selection, Shift+click selects the
   * range from the last clicked point. A plain click selects the point, or
   * keeps the selection it is in, and drags. In selection mode, Ctrl/Cmd or
   * Shift+click grows the box to take in the point.
   */
  const pointDown = (e: PointerEvent<Element>, i: number) => {
    if (e.button !== 0 || tool) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (boxMode) {
        selectIn(boxed(extended(box ?? spanned(actions[i], actions[i]), actions[i])));
        return;
      }
      if (e.shiftKey) {
        // The anchor may be past the end after deleting points. The regions' points in the range stay out.
        const from = Math.min(anchor.current ?? i, actions.length - 1);
        setSelected(new Set(Array.from({ length: Math.abs(i - from) + 1 }, (_, k) => Math.min(i, from) + k).filter((k) => !regionAt(regions, actions[k].at))));
        return;
      }
      anchor.current = i;
      setSelected((sel) => {
        const next = new Set(sel);
        if (!next.delete(i)) next.add(i);
        return next;
      });
      return;
    }
    anchor.current = i;
    const group = selected.has(i) ? [...selected] : [i];
    setSelected(new Set(group));
    drag(e, group);
  };

  /** Move the playhead to `t` ms, within the media. */
  const seek = (t: number) => {
    const media = videoRef.current;
    if (!media) return;
    t = clamp(t, 0, (media.duration || 0) * 1000);
    media.currentTime = t / 1000;
    setTime(t);
  };
  /** The point after (`dir` 1) or before (-1) the playhead; half a ms of slack for the media's rounding. */
  const neighbour = (dir: 1 | -1) => actions[dir > 0 ? byTime(actions, time + 0.5) : byTime(actions, time - 0.5) - 1];

  /** Drag the playhead to seek; playback pauses while dragging, as in the player. */
  const dragPlayhead = (e: PointerEvent<SVGGElement>) => {
    // The points are drawn over the playhead.
    const hit = pointUnder(e);
    if (hit !== null) return pointDown(e, hit);
    const media = videoRef.current;
    if (!media || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    const wasPlaying = !media.paused;
    media.pause();
    const move = (m: globalThis.PointerEvent) => seek(pointerAt(m).at);
    track(target, e, move, () => {
      if (wasPlaying) void media.play();
    });
  };

  /** The time the minimap shows: the script (the main one too, in the advanced editor), the video and the visible time, whichever is longest. */
  const total = Math.max(end, main.actions[main.actions.length - 1]?.at ?? 0, videoDuration, view.span);
  const minimapX = (at: number) => (at / total) * width;
  /**
   * Drag the visible time around in the minimap. Pressed outside it, it
   * centres on the pointer first, as in a code editor's minimap.
   */
  const dragMinimap = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    const left = target.getBoundingClientRect().left;
    const at = (m: { clientX: number }) => ((m.clientX - left) / width) * total;
    const pressed = at(e);
    const offset = pressed >= view.from && pressed <= view.from + view.span ? pressed - view.from : view.span / 2;
    const move = (m: { clientX: number }) => setView((v) => ({ ...v, from: clamp(at(m) - offset, 0, total - v.span) }));
    move(e);
    target.setPointerCapture(e.pointerId);
    target.addEventListener("pointermove", move);
    target.addEventListener("lostpointercapture", () => target.removeEventListener("pointermove", move), { once: true });
  };

  /** Select the markers `ms`, clearing the point selection. */
  const selectMarkers = (ms: Iterable<Marker>) => {
    setMarked(new Set(ms));
    setSelected(new Set());
    setBox(null);
  };
  const isChapter = (m: Marker): m is Chapter => chapters.includes(m as Chapter);
  const timeOf = (m: Marker) => (isChapter(m) ? m.start : m.time);

  /** Add a bookmark at `time` ms, with the last used name, and select it. */
  const addBookmark = (time: number) => {
    const added = { name: lastName, time };
    editLabel.current = "Add marker";
    setScript((s) => withBookmarks(s, [...s.bookmarks, added].sort((a, b) => a.time - b.time)));
    selectMarkers([added]);
    markerAnchor.current = added;
  };

  /**
   * A press on a marker selects it, and dragging it moves it: a chapter's
   * `sides`, both to move it, between its neighbours and 0 and at least 1 ms
   * long; a bookmark, with the other selected ones, anywhere from 0, past other
   * bookmarks. It never draws a chapter. Only bookmarks are selected together,
   * as by `markerPicked`. Pressed twice in a row, it opens the selection's
   * name field.
   */
  const markerDown = (e: PointerEvent<HTMLElement>, m: Marker, sides: ("start" | "end")[] = ["start", "end"]) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (markerPicked(e, m)) return;
    markerAnchor.current = m;
    const group = !isChapter(m) && marked.has(m) ? [...marked] : [m];
    selectMarkers(group);
    const twice = lastPress.current?.m === m && e.timeStamp - lastPress.current.at < 500;
    lastPress.current = twice ? null : { m, at: e.timeStamp };
    if (twice) return rename(group);
    const i = chapters.indexOf(m as Chapter);
    const [lo, hi] = [chapters[i - 1]?.end ?? 0, chapters[i + 1]?.start ?? Infinity];
    /** How far they can go, from where they started. */
    const [dtMin, dtMax] = !isChapter(m) ? [-Math.min(...group.map(timeOf)), Infinity] : [
      sides.includes("start") ? lo - m.start : m.start + 1 - m.end,
      sides.includes("end") ? hi - m.end : m.end - 1 - m.start,
    ];
    const label = group.length > 1 ? `Move ${group.length} markers` : !isChapter(m) ? "Move marker" : sides.length === 1 ? "Resize chapter" : "Move chapter";
    const [origin, x0] = [pointerAt(e).at, e.clientX];
    let moved = false;
    dragging.current = true;
    const move = (p: globalThis.PointerEvent) => {
      moved ||= Math.abs(p.clientX - x0) > 3;
      if (!moved) return;
      const dt = clamp(pointerAt(p).at - origin, dtMin, dtMax);
      // From where they started, so the lists from the press stay the ones to change.
      const to = new Map<Marker, Marker>(group.map((g) => [g, isChapter(g)
        ? { ...g, start: g.start + (sides.includes("start") ? dt : 0), end: g.end + (sides.includes("end") ? dt : 0) }
        : { ...g, time: g.time + dt }]));
      editLabel.current = label;
      // The Markers regions follow each step, from the one before.
      setScript((s) => withBookmarks({ ...s, chapters: swapped(chapters, to) }, swapped(bookmarks, to).sort((a, z) => a.time - z.time)));
      setMarked(new Set(to.values()));
      markerAnchor.current = to.get(m)!;
    };
    // Scrolling stops where they can go no further that way.
    const scrolls = (dir: number, p: globalThis.PointerEvent) => {
      const dt = pointerAt(p).at - origin;
      return dir > 0 ? dt < dtMax : dt > dtMin;
    };
    // Followed on the graph and lane, which stay, not the marker: a flag's element can go out of view, or over to another bookmark, as it passes them.
    track(timeRef.current!, e, move, () => {
      dragging.current = false;
      setDragEnds((k) => k + 1);
    }, scrolls);
  };

  /**
   * Select bookmarks together on a click on the bookmark `m` with a modifier:
   * Ctrl/Cmd toggles it in the selection, Shift selects the ones from the last
   * clicked. Returns whether it did.
   */
  const markerPicked = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, m: Marker) => {
    if (isChapter(m)) return false;
    if (e.ctrlKey || e.metaKey) {
      markerAnchor.current = m;
      const next = new Set([...marked].filter((o) => !isChapter(o)));
      if (!next.delete(m)) next.add(m);
      selectMarkers(next);
      return true;
    }
    if (!e.shiftKey) return false;
    const [i, j] = [bookmarks.indexOf(markerAnchor.current as Bookmark), bookmarks.indexOf(m)];
    selectMarkers(i < 0 ? [m] : bookmarks.slice(Math.min(i, j), Math.max(i, j) + 1));
    return true;
  };

  /**
   * Open the name field on the markers `ms`, named as the first in time, to
   * give them all one name or delete them; a bookmark's accepted name is the
   * next one's.
   */
  const rename = (ms: Marker[]) => {
    ms = [...ms].sort((a, b) => timeOf(a) - timeOf(b));
    const times = ms.flatMap((m) => (isChapter(m) ? [m.start, m.end] : [m.time]));
    const label = ms.length > 1 ? `Rename ${ms.length} markers` : isChapter(ms[0]) ? "Rename chapter" : "Rename marker";
    setNaming({ from: Math.min(...times), to: Math.max(...times), name: ms[0].name, remove: () => removeMarkers(ms), done: (name) => {
      if (name && !ms.every(isChapter)) setLastName(name);
      if (!name || ms.every((m) => m.name === name)) return;
      const to = new Map<Marker, Marker>(ms.map((m) => [m, { ...m, name }]));
      editLabel.current = label;
      setScript((s) => withBookmarks({ ...s, chapters: swapped(s.chapters, to) }, swapped(s.bookmarks, to)));
      setMarked(new Set(to.values()));
    } });
  };

  const removeMarkers = (ms: Marker[]) => {
    editLabel.current = ms.length > 1 ? `Delete ${ms.length} markers` : isChapter(ms[0]) ? "Delete chapter" : "Delete marker";
    setScript((s) => withBookmarks({ ...s, chapters: s.chapters.filter((c) => !ms.includes(c)) }, s.bookmarks.filter((b) => !ms.includes(b))));
    setMarked(new Set());
  };

  /** Select the region `r`, clearing the point and marker selection. */
  const selectRegion = (r: Region) => {
    setRegionOn(r);
    setSelected(new Set());
    setMarked(new Set());
    setBox(null);
  };

  /** Unlock the region `r`: it goes, and its points become ordinary points, selected; an instance's regions become regions of their own, their points staying theirs. */
  const unlockRegion = (r: Region) => {
    const inner = isInstance(r) ? r.snippet.regions : [];
    editLabel.current = `Unlock ${regionNoun(r)}`;
    setScript((s) => ({ ...s, regions: [...s.regions.filter((o) => o !== r), ...inner].sort((a, b) => a.from - b.from) }));
    setSelected(new Set(pointsOf(r).filter((i) => !regionAt(inner, actions[i].at))));
  };

  /** The indices of the points in `r`'s time. */
  const pointsOf = (r: Region) => Array.from({ length: afterTime(actions, r.to) - byTime(actions, r.from) }, (_, k) => byTime(actions, r.from) + k);

  /** Give the instance `r` the name `name`. */
  const renameInstance = (r: Instance, name: string) => {
    const renamed = { ...r, snippet: { ...r.snippet, name } };
    editLabel.current = `Rename ${regionNoun(r)} to "${name}"`;
    setScript((s) => ({ ...s, regions: s.regions.map((o) => (o === r ? renamed : o)) }));
    setRegionOn(renamed);
  };
  /** The selected instance's Name field as typed, until accepted with Enter or by leaving it; empty, it is refused. */
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  /** Delete the region `r` with its points, an instance with its regions; `verb` names the edit. */
  const deleteRegion = (r: Region, verb = "Delete") => {
    editLabel.current = `${verb} ${regionNoun(r)}`;
    setScript((s) => ({ ...s, actions: s.actions.filter((a) => a.at < r.from || a.at > r.to), regions: s.regions.filter((o) => o !== r) }));
    setRegionOn(null);
  };

  /** Close the name field, accepting what was typed unless `accept` is false or it is empty. */
  const closeNaming = (accept: boolean) => {
    const name = accept ? naming!.name.trim() : "";
    naming!.done(name || null);
    setNaming(null);
  };

  /**
   * A press on empty lane: a drag draws a chapter, within the gap between the
   * chapters around it, and opens its name field; a click adds a bookmark.
   */
  const laneDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const at = Math.max(pointerAt(e).at, 0);
    const n = chapters.filter((c) => c.start <= at).length;
    const [lo, hi] = [chapters[n - 1]?.end ?? 0, chapters[n]?.start ?? Infinity];
    // On the edge of a chapter, where its band ends a pixel short.
    if (at < lo) return;
    const x0 = e.clientX;
    let drawn: Chapter | null = null;
    dragging.current = true;
    const move = (m: globalThis.PointerEvent) => {
      if (!drawn && Math.abs(m.clientX - x0) <= 3) return;
      const t = clamp(pointerAt(m).at, lo, hi);
      if (t === at) return;
      const [old, chapter] = [drawn, { name: `Chapter ${n + 1}`, start: Math.min(at, t), end: Math.max(at, t) }];
      drawn = chapter;
      editLabel.current = "Add chapter";
      setScript((s) => ({ ...s, chapters: [...s.chapters.filter((c) => c !== old), chapter].sort((a, b) => a.start - b.start) }));
    };
    // Scrolling stops at the gap's ends.
    const scrolls = (dir: number, m: globalThis.PointerEvent) => (dir > 0 ? pointerAt(m).at < hi : pointerAt(m).at > lo);
    track(e.currentTarget, e, move, () => {
      const chapter = drawn;
      if (!chapter) {
        dragging.current = false;
        return addBookmark(at);
      }
      selectMarkers([chapter]);
      // The drag ends once named, so naming it is part of adding it.
      setNaming({ from: chapter.start, to: chapter.end, name: chapter.name, done: (name) => {
        if (name && name !== chapter.name) {
          const renamed = { ...chapter, name };
          setScript((s) => ({ ...s, chapters: s.chapters.map((c) => (c === chapter ? renamed : c)) }));
          setMarked(new Set([renamed]));
        }
        dragging.current = false;
        setDragEnds((k) => k + 1);
      } });
    }, scrolls);
  };

  /** The fields of the advanced editor's Scale, in %, as typed. */
  const [scale, setScale] = useState({ time: "100", out: "0", in: "100" });
  /** The fields of the advanced editor's Shift depth, as typed, in depth. */
  const [shift, setShift] = useState({ offset: "0", out: "0", in: "100" });
  /** The field of the advanced editor's Max speed, as typed. */
  const [maxSpeed, setMaxSpeed] = useState("");
  /** Which end Max speed keeps: In only moves points deeper, keeping the In reversals; Out only moves them out. */
  const [speedAnchor, setSpeedAnchor] = usePersistedState<"in" | "out">("ossm:editorSpeedAnchor", "in", localStorage);
  /** Generate's setup for new runs, remembered unlike the other tools' fields. */
  const [remembered, setRemembered] = usePersistedState<GenerateSetup>("ossm:editorGenerate", GENERATE_DEFAULTS, localStorage);
  /** The setup of the region being edited, its own; the remembered one stays as it is. */
  const [regionSetup, setRegionSetup] = useState(GENERATE_DEFAULTS);
  /** Generate's setup as shown and changed: the edited region's, or the remembered one. */
  const [genSetup, setGenSetup] = tool?.region ? [regionSetup, setRegionSetup] : [remembered, setRemembered];
  /** Generate shows its Interval or Speed in a view of its own below the graph. */
  const [timingView, setTimingView] = usePersistedState("ossm:editorTimingView", true, localStorage);
  /** The timing view's height while its function is edited, in px, its top dragged then. */
  const [timingTall, setTimingTall] = usePersistedState("ossm:editorTimingHeight", TIMING_HEIGHT, localStorage);
  /** Generate's range box fields, as typed: From and To in seconds as shown, Out and In in depth. */
  const [genRange, setGenRange] = useState({ from: "0", to: "0", out: "0", in: "100" });
  /** The part of Generate's or Repeat's setup shown, whose handles the graph shows; Generate's Layout, Repeat's Pattern, on opening. */
  const [genPart, setGenPart] = useState<GenPart>("position");
  /** The timing view's height as shown, its first while another part is edited. */
  const timingHeight = genPart === "timing" ? timingTall : TIMING_HEIGHT;
  /** Repeat's setup for new runs, remembered as Generate's; a region's own while editing it. */
  const [rememberedRepeat, setRememberedRepeat] = usePersistedState<RepeatSetup>("ossm:editorRepeat", REPEAT_DEFAULTS, localStorage);
  const [regionRepeat, setRegionRepeat] = useState(REPEAT_DEFAULTS);
  const [repSetup, setRepSetup] = tool?.region ? [regionRepeat, setRegionRepeat] : [rememberedRepeat, setRememberedRepeat];
  /** Repeat's pattern: its box's start, in ms, its points, edited while it is open, in the script's times, and the box's fields as typed: Length in s, Out and In in depth. */
  const [repBox, setRepBox] = useState({ from: 0, pattern: [] as Action[], length: "1", out: "0", in: "100" });
  /** A part's header in Generate's list, pressed to expand it: its name, then `right`, the part's controls while it is expanded, else a summary. */
  const partHeader = (part: GenPart, label: string, right?: ReactNode) => (
    <Flex gap="2" align="center" justify="between" minHeight="24px">
      <Flex
        align="center"
        gap="2"
        flexGrow="1"
        role="button"
        tabIndex={0}
        aria-expanded={genPart === part}
        onClick={() => setGenPart(part)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setGenPart(part))}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <ChevronRightIcon style={{ flexShrink: 0, transform: genPart === part ? "rotate(90deg)" : undefined }} />
        <Text size="2" weight={genPart === part ? "medium" : undefined}>{label}</Text>
      </Flex>
      {genPart === part ? right : <Text size="1" color="gray">{right}</Text>}
    </Flex>
  );

  /** Open a tool on the selected points, or all but the regions', from their defaults. */
  const openTool = (kind: ToolKind) => {
    const picked = selected.size ? [...selected].sort((a, b) => a - b) : [...actions.keys()].filter((i) => !regionAt(regions, actions[i].at));
    const fastest = fastestOf(actions, picked);
    setTool({ kind, actions, picked, fastest });
    const depths = picked.map((i) => actions[i].pos);
    setScale({ time: "100", out: String(100 - Math.max(...depths)), in: String(100 - Math.min(...depths)) });
    setShift({ offset: "0", out: "0", in: "100" });
    setMaxSpeed(fastest === null ? "" : String(Math.ceil(fastest)));
    // Over the selected points' time, or the view's.
    const [from, to] = selected.size ? [actions[picked[0]].at, actions[picked[picked.length - 1]].at] : [Math.round(view.from), Math.round(view.from + view.span)];
    setGenRange(rangeFields({ from, to, low: 0, high: 100 }, zero));
    // Repeat's pattern, the selected points: its Length their span, and their average spacing unless they end where they start, so the copies don't meet on one ms.
    const pattern = picked.map((i) => actions[i]);
    if (kind === "repeat") {
      const span = pattern[pattern.length - 1].at - pattern[0].at;
      const length = span + (pattern[0].pos === pattern[pattern.length - 1].pos ? 0 : Math.round(span / (pattern.length - 1)));
      setRepBox({ from: pattern[0].at, pattern, length: String(length / 1000), out: String(100 - Math.max(...depths)), in: String(100 - Math.min(...depths)) });
    }
    setGenPart("position");
    setBox(null);
  };

  /** Edit the region `r` in place: Generate or Repeat on its own setup and box; not while placing. */
  const editRegion = (r: Region) => {
    if (placing) return;
    if (isInstance(r)) return openAdvanced(undefined, r);
    if (isRepeat(r)) {
      const { pattern, length, bottom, top, ...setup } = r.repeat;
      setTool({ kind: "repeat", actions, picked: [], fastest: null, region: r });
      setRegionRepeat(setup);
      setRepBox({ from: r.from, pattern: pattern.map((a) => ({ at: a.at + r.from, pos: a.pos })), length: String(length / 1000), out: String(100 - top), in: String(100 - bottom) });
    } else {
      setTool({ kind: "generate", actions, picked: [], fastest: null, region: r });
      setRegionSetup(r.generate);
      setGenRange(rangeFields(r, zero));
    }
    setGenPart("position");
    setBox(null);
  };

  /** Repeat's box fields as numbers while it is open; null while one is refused. */
  const repParams = tool?.kind === "repeat" ? repeatParams(repBox) : null;
  /** Repeat's copies, their starts and end, while it is open; null while its box or Count is refused. */
  const repRun = useMemo(() => repParams && repeated(repSetup, repBox.from, repBox.pattern, repParams.length, repParams.bottom, repParams.top), [repSetup, repBox, tool]);

  /** The open tool's result, from the points it was opened on, as its fields stand; null while one is invalid. */
  const preview = useMemo(() => {
    if (!tool) return null;
    const { kind, actions, picked } = tool;
    if (kind === "scale") {
      const params = scaleParams(scale);
      return params && scaled(actions, picked, params.time, params.low, params.high, regions);
    }
    if (kind === "shift") {
      const params = shiftParams(shift);
      return params && shifted(actions, picked, params.offset, params.min, params.max);
    }
    if (kind === "generate") {
      // Every point in the range's time goes, whatever its depth; editing a region, its old points and band too.
      const range = rangeParams(genRange, zero);
      const made = range && generated(genSetup, range, bookmarks);
      if (!range || !made) return null;
      const { region } = tool;
      const rest = region ? actions.filter((a) => a.at < region.from || a.at > region.to) : actions;
      const [before, after] = [rest.slice(0, byTime(rest, range.from)), rest.slice(afterTime(rest, range.to))];
      return { actions: [...before, ...made, ...after], selected: new Set(made.map((_, i) => before.length + i)), regions: region && regions.filter((r) => r !== region) };
    }
    if (kind === "repeat") {
      // The pattern's own points go, and every point in the copies' time; editing a region, its old points and band too.
      if (!repRun?.actions) return null;
      const { region } = tool;
      const hit = new Set(picked);
      const rest = actions.filter((a, i) => !hit.has(i) && (a.at < repBox.from || a.at > repRun.end) && (!region || a.at < region.from || a.at > region.to));
      const at = byTime(rest, repBox.from);
      return { actions: [...rest.slice(0, at), ...repRun.actions, ...rest.slice(at)], selected: new Set(repRun.actions.map((_, i) => at + i)), regions: region && regions.filter((r) => r !== region) };
    }
    const limit = typed(maxSpeed);
    return limit > 0 ? speedLimited(actions, picked, limit, speedAnchor === "out") : null;
  }, [tool, scale, shift, maxSpeed, speedAnchor, genSetup, genRange, zero, bookmarks, regions, repRun, repBox.from]);

  /** The open tool's affected points as it was opened on them: the first's time `t0`, the last's `t1`, their lowest depth `lo` and highest `hi`; null without any. */
  const toolSpan = useMemo(() => {
    if (!tool?.picked.length) return null;
    const { actions, picked } = tool;
    const depths = picked.map((i) => actions[i].pos);
    return { t0: actions[picked[0]].at, t1: actions[picked[picked.length - 1]].at, lo: Math.min(...depths), hi: Math.max(...depths) };
  }, [tool]);
  /** Scale's box while it is open: the result's bounding box; null while a field is refused. */
  const scaleBox = (() => {
    const params = tool?.kind === "scale" && toolSpan && scaleParams(scale);
    return params ? { ...params, ...toolSpan!, to: toolSpan!.t0 + ((toolSpan!.t1 - toolSpan!.t0) * params.time) / 100 } : null;
  })();
  /** Shift depth's fields while it is open; null while one is refused. */
  const shiftBox = tool?.kind === "shift" ? shiftParams(shift) : null;
  /** Generate's range box while it is open; null while a field is refused. */
  const genBox = tool?.kind === "generate" ? rangeParams(genRange, zero) : null;
  /** The box the open tool's functions run across: Generate's, or Repeat's copies' time over its pattern box's depths. */
  const fnBox = genBox ?? (repRun && repParams && { from: repBox.from, to: repRun.end, low: repParams.bottom, high: repParams.top });
  /** The open tool's functions, Generate's or Repeat's, as shown, and a change to one of them. */
  const fnSetup: Partial<Record<FuncKey, Func>> = tool?.kind === "repeat" ? repSetup : genSetup;
  const setFunc = (key: FuncKey, f: (func: Func) => Func) => (tool?.kind === "repeat"
    ? setRepSetup((s) => ({ ...s, [key]: f(s[key as "time"]) }))
    : setGenSetup((s) => ({ ...s, [key]: f(s[key as "interval"]) })));
  /** The open tool's timing function, shown in its own view below the graph: Generate's Interval or Speed, none with Markers timing, or Repeat's Time. */
  const timingKey: FuncKey | null = tool?.kind === "repeat" ? "time" : tool?.kind === "generate" && genSetup.timing !== "markers" ? genSetup.timing : null;
  /** Where `u` % of a function's range is, in ms, across the box, and back. */
  const rangeTime = (u: number) => fnBox!.from + (u / 100) * (fnBox!.to - fnBox!.from);
  const rangeU = (t: number) => (fnBox!.to > fnBox!.from ? ((t - fnBox!.from) / (fnBox!.to - fnBox!.from)) * 100 : 0);
  /** A function's value at `t` ms, a ramp's or spline's along its range, the rest from the box's start. */
  const valueAt = (key: FuncKey, t: number) => {
    const func = fnSetup[key]!;
    return RANGED.includes(func.shape) ? funcAt(func, rangeU(t), 100) : funcAt(func, t - fnBox!.from, fnBox!.to - fnBox!.from);
  };
  /** Why the open tool's result, though shown, cannot be applied: it would put points into a region or stretch one. */
  const toolBlocked = genBox && regions.some((r) => r !== tool!.region && r.from <= genBox.to && r.to >= genBox.from) ? "The box overlaps a region"
    : genBox && tool!.region && genBox.to <= genBox.from ? "A region's box needs a length"
    : repRun && regions.some((r) => r !== tool!.region && r.from <= repRun.end && r.to >= repBox.from) ? "The copies overlap a region"
    : repRun && repRun.end <= repBox.from ? "The copies need a length"
    : scaleBox && scaleBox.time !== 100 && regions.some((r) => r.from > scaleBox.t0 && r.to < scaleBox.t1) ? "Time cannot be scaled across a region"
    : null;
  /** Whether Generate's box holds a bookmark, so Markers timing can be chosen. */
  const genMarked = !!genBox && bookmarks.some((b) => b.time >= genBox.from && b.time <= genBox.to);
  /** The timing function shows in its own view below the graph. */
  const timingShown = !!fnBox && timingView && !!timingKey;
  const maxSpan = Math.max(end, main.actions[main.actions.length - 1]?.at ?? 0, videoDuration, fnBox?.to ?? 0, MAX_SPAN_FLOOR);
  const spanStep = SPAN_STEPS.find((s) => s * SPAN_STEP_COUNT >= maxSpan / 1000) ?? SPAN_STEPS[SPAN_STEPS.length - 1];

  // The wheel scrolls through time, with Ctrl it zooms around the pointer. Not passive, to keep the page from scrolling.
  useEffect(() => {
    const el = timeRef.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      setView((v) => {
        if (!(e.ctrlKey || e.metaKey)) return { ...v, from: Math.max(v.from + ((e.deltaX || e.deltaY) / rect.width) * v.span, 0) };
        const span = clamp(v.span * Math.exp(e.deltaY * 0.002), MIN_SPAN, maxSpan);
        return { from: Math.max(v.from + fraction * (v.span - span), 0), span };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [setView, maxSpan]);

  /** Times every 2 px across the functions' box's part in view, where they are drawn. */
  const genTimes = (() => {
    if (!fnBox || !(width > 0)) return [];
    const [t0, t1, step] = [Math.max(fnBox.from, view.from), Math.min(fnBox.to, view.from + view.span), (2 / width) * view.span];
    return t1 < t0 ? [] : Array.from({ length: Math.ceil((t1 - t0) / step) + 1 }, (_, i) => Math.min(t0 + i * step, t1));
  })();
  /** The function `key`'s curve across its box, as polyline points, `at` placing its values; none while a field is refused. */
  const genCurve = (key: FuncKey, at: (v: number) => number) => {
    const values = genTimes.map((t) => valueAt(key, t));
    return values.some(Number.isNaN) ? "" : genTimes.map((t, i) => `${x(t)},${at(values[i])}`).join(" ");
  };
  /** The timing view's scale, bottom and top: a spline's Min and Max, else 0 to a quarter above the highest of the function's fields, so it stays put while dragging. */
  const [timingLow, timingHigh] = (() => {
    if (!timingKey) return [0, 1];
    const func = fnSetup[timingKey]!;
    if (func.shape === "spline") return [typed(func.min ?? ""), typed(func.max ?? "")];
    const peak = Math.max(...SPANNED.map((f) => typed(func[f] ?? "")).filter(Number.isFinite));
    return [0, peak > 0 ? peak * 1.25 : 1];
  })();
  /** Where a value of Generate's Interval or Speed goes in the timing view, in px. */
  const timingY = (v: number) => PAD + (1 - clamp((v - timingLow) / (timingHigh - timingLow), 0, 1)) * (timingHeight - 2 * PAD);

  /**
   * Drag one of a tool's handles in the graph; `move` gets how far the pointer
   * has gone in time and depth since the press, the depth in whole steps and
   * past the graph's top and bottom too; in a view where 100 spans `height` px.
   */
  const dragHandle = (e: PointerEvent<SVGElement>, move: (dt: number, dp: number) => void, height = plotHeight - 2 * PAD) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const [origin, y0] = [pointerAt(e).at, e.clientY];
    track(e.currentTarget.ownerSVGElement!, e, (m) => move(pointerAt(m).at - origin, Math.round(((y0 - m.clientY) / height) * 100)));
  };

  /** Drag Scale's box by `sides`: its right edge sets Time %, its top and bottom Out and In, which may pass each other; its body both, within 0–100. */
  const dragScale = (e: PointerEvent<SVGRectElement>, sides: ("to" | "low" | "high")[]) => {
    const start = scaleBox!;
    // Stops where any side dragged would leave 0–100, so the body keeps its height.
    const dragged = (["low", "high"] as const).filter((side) => sides.includes(side));
    const [dpMin, dpMax] = [Math.max(...dragged.map((side) => -start[side])), Math.min(...dragged.map((side) => 100 - start[side]))];
    dragHandle(e, (dt, dp) => {
      const time = Math.max(Number((((start.to + dt - start.t0) / (start.t1 - start.t0)) * 100).toFixed(2)), 0.01);
      const depth = (side: "low" | "high") => String(100 - (start[side] + clamp(dp, dpMin, dpMax)));
      setScale((f) => ({
        time: sides.includes("to") ? String(time) : f.time,
        out: sides.includes("high") ? depth("high") : f.out,
        in: sides.includes("low") ? depth("low") : f.in,
      }));
    });
  };

  /** Drag Shift depth's `side`, a position's: the box sets Offset, −100–100; Out and In stay within 0–100 and stop at each other. */
  const dragShift = (e: PointerEvent<SVGRectElement>, side: "offset" | "min" | "max") => {
    const { offset, min, max } = shiftBox!;
    dragHandle(e, (_, dp) => {
      const value = side === "offset" ? clamp(Math.round(offset + dp), -100, 100) : side === "min" ? clamp(min + dp, 0, max) : clamp(max + dp, min, 100);
      setShift((f) => ({ ...f, ...(side === "offset" ? { offset: String(-value) } : side === "min" ? { in: String(100 - value) } : { out: String(100 - value) }) }));
    });
  };

  /** Drag the `sides` of Generate's box, as the selection box's: an edge or corner resizes it, all four move it; from 0 on and within 0–100. */
  const dragGenerate = (e: PointerEvent<SVGRectElement>, sides: (keyof Area)[]) => {
    const start = genBox!;
    dragHandle(e, (dt, dp) => {
      // Moved, it keeps its size.
      dt = Math.max(dt, sides.includes("from") ? -start.from : -Infinity);
      dp = clamp(dp, sides.includes("low") ? -start.low : -100, sides.includes("high") ? 100 - start.high : 100);
      const b = { ...start };
      for (const side of sides) b[side] = side === "from" || side === "to" ? Math.max(b[side] + dt, 0) : clamp(b[side] + dp, 0, 100);
      setGenRange(rangeFields(spanned({ at: b.from, pos: b.low }, { at: b.to, pos: b.high }), zero));
    });
  };

  /** Drag the `sides` of Repeat's pattern box: its right edge sets Length, from 1 ms; its top and bottom its depths, within 0–100, which may pass each other. */
  const dragRepeat = (e: PointerEvent<SVGRectElement>, sides: ("to" | "low" | "high")[]) => {
    const start = repParams!;
    dragHandle(e, (dt, dp) => {
      const [a, b] = [start.bottom + (sides.includes("low") ? dp : 0), start.top + (sides.includes("high") ? dp : 0)].map((v) => clamp(v, 0, 100));
      const length = sides.includes("to") ? Math.max(start.length + dt, 1) : start.length;
      setRepBox((f) => ({ ...f, length: String(length / 1000), out: String(100 - Math.max(a, b)), in: String(100 - Math.min(a, b)) }));
    });
  };

  /** The pattern point last pressed and when, to tell a double-click, as a knot's. */
  const patternPress = useRef<{ i: number; at: number } | null>(null);

  /**
   * Drag point `i` of Repeat's pattern `pattern`: in time between its
   * neighbours and within the box, in depth within 0–100. Pressed twice in a
   * row, it goes instead, while the pattern keeps two.
   */
  const dragPattern = (e: PointerEvent<SVGElement>, i: number, pattern = repBox.pattern) => {
    if (e.button !== 0) return;
    const twice = patternPress.current?.i === i && e.timeStamp - patternPress.current.at < 500;
    patternPress.current = twice ? null : { i, at: e.timeStamp };
    if (twice) {
      e.stopPropagation();
      if (pattern.length > 2) setRepBox((f) => ({ ...f, pattern: f.pattern.filter((_, j) => j !== i) }));
      return;
    }
    const a0 = pattern[i];
    const [lo, hi] = [i > 0 ? pattern[i - 1].at + 1 : repBox.from, Math.min(i < pattern.length - 1 ? pattern[i + 1].at - 1 : Infinity, repBox.from + repParams!.length)];
    dragHandle(e, (dt, dp) => setRepBox((f) => ({ ...f, pattern: f.pattern.map((a, j) => (j === i ? { at: clamp(a0.at + dt, lo, hi), pos: clamp(a0.pos + dp, 0, 100) } : a)) })));
  };

  /** Add a point to Repeat's pattern under the pointer, in its box's time, and drag it. */
  const addPattern = (e: PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    const p = pointerAt(e);
    p.at = clamp(p.at, repBox.from, repBox.from + repParams!.length);
    const { pattern } = repBox;
    if (pattern.some((a) => a.at === p.at)) return;
    const i = byTime(pattern, p.at);
    const next = [...pattern.slice(0, i), p, ...pattern.slice(i)];
    setRepBox((f) => ({ ...f, pattern: next }));
    dragPattern(e, i, next);
    // Not the first press of a double-click on the new point.
    patternPress.current = null;
  };

  /** The knot of a spline last pressed and when, to tell a double-click: the drag's pointer capture keeps the browser's own from reaching it. */
  const knotPress = useRef<{ key: string; i: number; at: number } | null>(null);
  const setKnots = (key: FuncKey, knots: Knots) => setFunc(key, (f) => ({ ...f, knots }));

  /**
   * Drag knot `i` of `knots`, the spline `key`'s: in value within 0–100 (%),
   * in the box or, for Interval, Speed and Time, the timing view; in time
   * between its neighbours, the end knots only in value.
   * Pressed twice in a row, it goes instead, unless it is an end.
   */
  const dragKnot = (e: PointerEvent<SVGElement>, key: FuncKey, knots: Knots, i: number) => {
    if (e.button !== 0) return;
    const twice = knotPress.current?.key === key && knotPress.current.i === i && e.timeStamp - knotPress.current.at < 500;
    knotPress.current = twice ? null : { key, i, at: e.timeStamp };
    const end = i === 0 || i === knots.length - 1;
    if (twice && !end) return setKnots(key, knots.filter((_, j) => j !== i));
    const { low, high } = fnBox!;
    const [t0, v0] = knots[i];
    const own = ownScale(key);
    dragHandle(e, (dt, dp) => {
      const t = end ? t0 : clamp(Math.round(rangeU(rangeTime(t0) + dt) * 100) / 100, knots[i - 1][0] + KNOT_GAP, knots[i + 1][0] - KNOT_GAP);
      // Out's and In's are depths, deeper down.
      const v = clamp(Math.round(v0 + (own ? dp : high > low ? (-dp / (high - low)) * 100 : 0)), 0, 100);
      setKnots(key, knots.map((k, j) => (j === i ? [t, v] : k)));
    }, own ? timingHeight - 2 * PAD : undefined);
  };

  /** Add a knot to the spline `key` where its line is under the pointer, and drag it. */
  const addKnot = (e: PointerEvent<SVGElement>, key: FuncKey) => {
    if (e.button !== 0) return;
    const knots = fnSetup[key]!.knots!;
    const u = Math.round(rangeU(pointerAt(e).at) * 100) / 100;
    const i = knots.findIndex(([t]) => t > u);
    if (i <= 0 || u - knots[i - 1][0] < KNOT_GAP || knots[i][0] - u < KNOT_GAP) return;
    const next: Knots = [...knots.slice(0, i), [u, Math.round(clamp(splineAt(knots, u), 0, 100))], ...knots.slice(i)];
    setKnots(key, next);
    dragKnot(e, key, next, i);
    // Not the first press of a double-click on the new knot.
    knotPress.current = null;
  };

  /**
   * The handles of the function `key` in the box or, for Interval, Speed and
   * Time, the timing view, `yOf` placing its values: a constant's line and a
   * noise's Min and Max drag up and down, as do a ramp's ends; a wave's line
   * moves its Phase, and its Min and Max together; its first peak in the box
   * moves its Max, the trough after it its Min, and either the Period, the
   * other staying; a pulse's falling edge its Width, around the peak, as does
   * the end of a trapezoid's hold on Max; a spline's knots and line as dragKnot's and
   * addKnot's. Values in whole steps: Out's and In's depths within 0–100,
   * Interval's (ms), Speed's and Time's from 1; none while a field they move is refused.
   */
  const funcHandles = (key: FuncKey, yOf: (v: number) => number) => {
    const func = fnSetup[key]!;
    const { from, to, low, high } = fnBox!;
    const own = ownScale(key);
    const f = (field: ShapeField) => typed(func[field] ?? "");
    const curve = genCurve(key, own ? timingY : (v) => yOf(clamp(v, 0, 100)));
    const fit = (v: number) => String(own ? Math.max(Math.round(v), 1) : clamp(Math.round(v), 0, 100));
    /** Drag a handle; `move` gets how far the pointer has gone in ms and in the function's value, and gives the fields it changes. */
    const drag = (e: PointerEvent<SVGElement>, move: (dt: number, dv: number) => Partial<Func>) => {
      // Out's and In's are depths, deeper down.
      const scale = own ? (timingHigh - timingLow) / 100 : high > low ? -100 / (high - low) : 0;
      dragHandle(e, (dt, dp) => setFunc(key, (s) => ({ ...s, ...move(dt, dp * scale) })), own ? timingHeight - 2 * PAD : undefined);
    };
    /** A value's line across the box, dragged by it or its grip at the right end; drawn unless it is a constant's, which its curve shows. */
    const line = (field: ShapeField) => {
      const [v0, ly] = [f(field), yOf(f(field))];
      if (!Number.isFinite(v0)) return null;
      const down = (e: PointerEvent<SVGElement>) => drag(e, (_, dv) => ({ [field]: fit(v0 + dv) }));
      return (
        <g key={field}>
          {field !== "value" && <line x1={x(from)} x2={x(to)} y1={ly} y2={ly} strokeDasharray="6 4" strokeWidth={1.5} style={{ stroke: "var(--accent-9)", pointerEvents: "none" }} />}
          {grip(`${field}-line`, [x(from), ly - GRIP / 2, x(to) - x(from), GRIP], "ns-resize", down)}
          {grip(`${field}-grip`, [x(to) - GRIP / 2, ly - GRIP / 2, GRIP, GRIP], "ns-resize", down, true)}
        </g>
      );
    };
    /** A square grip `t` ms into the box at value `v`. */
    const point = (k: string, t: number, v: number, cursor: string, down: (e: PointerEvent<SVGElement>) => void) => (Number.isFinite(t + v) ? grip(k, [x(from + t) - GRIP / 2, yOf(v) - GRIP / 2, GRIP, GRIP], cursor, down, true) : null);
    switch (func.shape) {
      case "constant":
        return line("value");
      case "noise":
        return <>{line("min")}{line("max")}</>;
      case "ramp":
        return <>
          {point("start", 0, f("start"), "ns-resize", (e) => drag(e, (_, dv) => ({ start: fit(f("start") + dv) })))}
          {point("end", rangeTime(100) - from, f("end"), "ns-resize", (e) => drag(e, (_, dv) => ({ end: fit(f("end") + dv) })))}
        </>;
      case "spline": {
        // An Interval or Speed spline's knots on its scale, the timing view's.
        const knotY = (v: number) => yOf(own ? timingLow + (v / 100) * (timingHigh - timingLow) : v);
        return <>
          {/* Its line, wider and unseen, adds a knot where clicked. */}
          <polyline points={curve} fill="none" strokeWidth={GRIP} stroke="transparent" style={{ cursor: "copy" }} onPointerDown={(e) => addKnot(e, key)} />
          {func.knots!.map(([t, v], i, knots) => grip(
            `${key}-${i}`,
            [x(rangeTime(t)) - GRIP / 2, knotY(v) - GRIP / 2, GRIP, GRIP],
            i === 0 || i === knots.length - 1 ? "ns-resize" : "move",
            (e) => dragKnot(e, key, knots, i),
            true,
          ))}
        </>;
      }
    }
    // A wave: Max on its first peak, a pulse's in the middle of its Width, Min on the trough half a period after.
    const period = f("period");
    if (!(period > 0)) return null;
    const half = func.shape === "pulse" ? f("width") / 200 : 0.25;
    /** The Phase, in %, that puts a peak `t` ms into the box with a period of `p`, and for a pulse half its Width `h`. */
    const phaseAt = (t: number, p: number, h = half) => String(Math.round((((h - t / p) % 1) + 1) % 1 * 1000) / 10);
    const peak = ((((half - f("phase") / 100) % 1) + 1) % 1) * period;
    // Moved together, Min and Max stop where either would leave its range, keeping the wave's height.
    const [lo, hi] = [Math.min(f("min"), f("max")), Math.max(f("min"), f("max"))];
    const shift = (dv: number) => (own ? Math.max(dv, 1 - lo) : clamp(dv, -lo, 100 - hi));
    return <>
      {/* Its line, wider and unseen, under the grips. */}
      <polyline points={curve} fill="none" strokeWidth={GRIP} stroke="transparent" style={{ cursor: "move" }} onPointerDown={(e) => drag(e, (dt, dv) => ({
        min: fit(f("min") + shift(dv)),
        max: fit(f("max") + shift(dv)),
        phase: phaseAt(peak + dt, period),
      }))} />
      {/* The peak and the trough each set the Period with the other staying. */}
      {point("max", peak, f("max"), "move", (e) => drag(e, (dt, dv) => {
        const p = Math.max(Math.round(period - 2 * dt), 2);
        return { max: fit(f("max") + dv), period: String(p), phase: phaseAt(peak + period / 2 - p / 2, p) };
      }))}
      {point("min", peak + period / 2, f("min"), "move", (e) => drag(e, (dt, dv) => {
        const p = Math.max(Math.round(period + 2 * dt), 2);
        return { min: fit(f("min") + dv), period: String(p), phase: phaseAt(peak, p) };
      }))}
      {/* A pulse's falling edge after the peak, halfway up, sets its Width around the peak, which stays, as does the trough. */}
      {/* A trapezoid's hold on Max ends a quarter of its Width after the peak. */}
      {func.shape === "trapezoid" && point("width", peak + (period * clamp(f("width"), 0, 99)) / 400, f("max"), "ew-resize", (e) => drag(e, (dt) => ({
        width: String(clamp(Math.round(clamp(f("width"), 0, 99) + (400 * dt) / period), 0, 99)),
      })))}
      {func.shape === "pulse" && point("width", peak + period * half, (f("min") + f("max")) / 2, "ew-resize", (e) => drag(e, (dt) => {
        const w = clamp(Math.round(((2 * (period * half + dt)) / period) * 100), 1, 99);
        return { width: String(w), phase: phaseAt(peak, period, w / 200) };
      }))}
    </>;
  };

  /** A grip of a tool's handle in the graph, at `x`, `y` and as wide and high as given; `square` shows it, as the selection box's corners. */
  const grip = (key: string, [gx, gy, gw, gh]: number[], cursor: string, down: (e: PointerEvent<SVGRectElement>) => void, square = false) => (
    <rect
      key={key}
      x={gx}
      y={gy}
      width={gw}
      height={gh}
      style={square ? { fill: "var(--color-panel-solid)", stroke: "var(--accent-9)", cursor } : { fill: "transparent", cursor }}
      onPointerDown={down}
    />
  );

  /**
   * Apply the open tool's result as one edit, unless it leaves the points as
   * they are, and go back to the tools. Generate's box becomes a region of its
   * points, with its own copy of the setup, and selected; not a box without
   * length, whose point stays ordinary. Repeat's copies become a region too,
   * with its pattern. Editing a region, it takes the old one's place.
   */
  const applyTool = () => {
    const { kind, picked, region } = tool!;
    const next = preview!;
    setTool(null);
    // Repeat's pattern, the points in its box, timed from its start.
    const pattern = repBox.pattern.filter((a) => a.at <= repBox.from + (repParams?.length ?? 0)).map((a) => ({ at: a.at - repBox.from, pos: a.pos }));
    const made: Inner | null = kind === "generate" && genBox!.to > genBox!.from ? { ...genBox!, generate: structuredClone(genSetup) }
      : kind === "repeat" ? { from: repBox.from, to: repRun!.end, repeat: { ...structuredClone(repSetup), pattern, length: repParams!.length, bottom: repParams!.bottom, top: repParams!.top } }
      : null;
    const same = next.actions.length === actions.length && next.actions.every((a, i) => a.at === actions[i].at && a.pos === actions[i].pos);
    if (same && (!made || JSON.stringify(made) === JSON.stringify(region))) return;
    editLabel.current = region ? "Edit region"
      : kind === "repeat" ? `Repeat ${points(pattern.length)} ×${repSetup.count}`
      : `${TOOLS.find((t) => t.kind === kind)!.verb} ${points(kind === "generate" ? next.selected.size : picked.length)}`;
    setScript((s) => ({ ...s, actions: next.actions, regions: made ? [...(next.regions ?? s.regions), made].sort((a, b) => a.from - b.from) : next.regions ?? s.regions }));
    if (made) selectRegion(made);
    else setSelected(next.selected);
  };

  const removeSelected = (verb = "Delete") => {
    editLabel.current = `${verb} ${points(selected.size)}`;
    setScript((s) => ({ ...s, actions: s.actions.filter((_, j) => !selected.has(j)) }));
    setSelected(new Set());
  };

  // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes. Ctrl/Cmd+A selects all points but the regions', or all bookmarks with markers
  // selected or over the marker lane; Escape none, Delete (or Backspace, the Mac's delete key) removes the selected ones or region; F2 renames the selected
  // markers, B adds a bookmark, P hides or shows the player, also with a tool open. Not while typing in a field.
  // With a tool open, Escape (also in its fields) discards it, and only undo and redo do the same; other keys do nothing.
  useWindowEvent("keydown", (e) => {
    if (tool && e.key === "Escape") return setTool(null);
    if (e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase();
    if (key === "p" && !e.ctrlKey && !e.metaKey && videoUrl) return togglePlayer();
    if (tool && !((e.ctrlKey || e.metaKey) && (key === "z" || key === "y"))) return;
    if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "y")) {
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo();
      else undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      if (marked.size || overLane.current) selectMarkers(bookmarks);
      else setSelected(new Set([...actions.keys()].filter((i) => !regionAt(regions, actions[i].at))));
    } else if (e.key === "Escape") {
      // Cancels placing points first.
      if (placing) cancelPlacing();
      else {
        setSelected(new Set());
        setMarked(new Set());
        setRegionOn(null);
        setBox(null);
      }
    } else if (e.key === "Enter" && ghost) {
      // Places the points being placed where they are shown, unless refused there.
      e.preventDefault();
      if (lifted) drop();
      else if (!refused) put(ghost, inserting);
    } else if (e.key === "s" && !e.ctrlKey && !e.metaKey) {
      toggleBoxMode();
    } else if (e.key === "m" && !e.ctrlKey && !e.metaKey) {
      toggleMove();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
      e.preventDefault();
      removeSelected();
    } else if ((e.key === "Delete" || e.key === "Backspace") && marked.size) {
      e.preventDefault();
      removeMarkers([...marked]);
    } else if ((e.key === "Delete" || e.key === "Backspace") && region) {
      e.preventDefault();
      deleteRegion(region);
    } else if (e.key === "F2" && marked.size) {
      e.preventDefault();
      rename([...marked]);
    } else if (e.key === "e" && !e.ctrlKey && !e.metaKey) {
      // With a region selected, edits it instead.
      if (region) editRegion(region);
      else openAdvanced();
    } else if (key === "b" && !e.ctrlKey && !e.metaKey && !advanced) {
      // At the playhead, or without media under the pointer.
      const at = videoUrl ? Math.round(time) : hoverAt.current;
      if (at !== null) addBookmark(at);
    }
  });

  /** The selected points, or the selected region with its points, as funscript JSON, timed from the first point. */
  /** Also adds them to the clipboard history. */
  const selectionJson = () => {
    const picked = region ? actions.slice(byTime(actions, region.from), afterTime(actions, region.to)) : [...selected].sort((a, b) => a - b).map((i) => actions[i]);
    const t0 = picked[0].at;
    return remember({ actions: picked.map((a) => ({ at: a.at - t0, pos: a.pos })), regions: region ? [movedBy(region, -t0)] : [] });
  };

  /** Cut the selected points, or region. */
  const cut = () => (region ? deleteRegion(region, "Cut") : removeSelected("Cut"));

  /** `clip` as funscript JSON, its regions under our own key. */
  const clipJson = (clip: Clip) => JSON.stringify(clip.regions.length ? { actions: clip.actions, ossmRsWebTools: { version: 1, regions: clip.regions } } : { actions: clip.actions });

  /** Put `copied` on top of the clipboard history, without a duplicate; returns its JSON. */
  const remember = (copied: Clip) => {
    const json = clipJson(copied);
    setHistory((h) => [copied, ...h.filter((c) => clipJson(c) !== json)].slice(0, HISTORY_SIZE));
    return json;
  };

  /** Paste a history entry and make it the clipboard again, on top of the history. */
  const pasteFromHistory = (copied: Clip) => {
    const json = remember(copied);
    pasteJson(json);
    navigator.clipboard.writeText(json).catch((e: Error) => setError(`Copying failed: ${e.message}`));
  };

  /** Stop placing points; moved ones go back where they were, still selected. */
  const cancelPlacing = () => {
    // A lifted instance's points are its own, so it is selected instead.
    if (lifted && liftedRegion) setRegionOn(liftedRegion);
    else if (lifted) setSelected(lifted);
    setPlacing(null);
    setLifted(null);
  };

  /**
   * Move mode: lift the selected points, as if cut, and drag them by the time
   * they cover. Leaves selection mode; again, places them.
   */
  const toggleMove = () => {
    if (lifted) return drop();
    if (!selected.size) return;
    const picked = [...selected].sort((a, b) => a - b).map((i) => actions[i]);
    setPlacing({ actions: picked.map((a) => ({ at: a.at - picked[0].at, pos: a.pos })), regions: [] });
    setPlaceAt(picked[0]);
    setLifted(selected);
    setLiftedRegion(null);
    setSelected(new Set());
    setBoxMode(false);
    setBox(null);
  };

  /** The library snippet at `path` as the advanced editor opens it: from `zero`, in whole ms; empty when it is gone. */
  const snippetFrom = (path: string[] | null, zero: number) => {
    const s = path && entryAt(library, path);
    return s && !isFolder(s) ? clipBy(s, zero) : { actions: [], regions: [] };
  };

  /**
   * Open the selected points in the advanced editor, or start it empty; its
   * undo history starts anew. In snippet mode, on the library snippet at the
   * `snippet`'s path, from the view's start, or empty for a new one. On an
   * `instance`, its points and regions, from its start.
   */
  const openAdvanced = (snippet?: Advanced["snippet"], instance?: Instance) => {
    if (placing || advanced) return;
    const from = instance ? pointsOf(instance) : !snippet && selected.size ? [...selected].sort((a, b) => a - b) : null;
    // In whole ms, as Generate's times count from it.
    const zero = Math.round(instance ? instance.from : from ? actions[from[0]].at : view.from);
    const doc = snippet ? snippetFrom(snippet.path, zero) : { actions: from?.map((i) => actions[i]) ?? [], regions: instance?.snippet.regions ?? [] };
    mainTimeline.current = timeline;
    setTimeline({ states: [{ ...doc, chapters, bookmarks, label: "Open" }], index: 0 });
    setAdvanced({ ...doc, zero, from, snippet, instance: instance && regions.indexOf(instance) });
    setSelected(new Set());
    setMarked(new Set());
    setBox(null);
  };

  /**
   * Leave the advanced editor for the main script and its undo history. Done
   * places the result with its regions in Move mode, where it was edited, with
   * the points it was opened from lifted, none when opened empty, and adds it
   * to the clipboard history; Cancel drops it, the points it was
   * opened from selected again. In snippet mode, Done saves it to the library
   * instead, a new one as `name`. Editing an instance, Done places one
   * instance of its name, the original lifted with its points, and Cancel
   * selects it again.
   */
  const closeAdvanced = (done: boolean, name?: string) => {
    const { actions: result, regions: made, from, snippet } = advanced!;
    const instance = advanced!.instance === undefined ? null : (main.regions[advanced!.instance] as Instance);
    setLeaving(false);
    setTimeline(mainTimeline.current ?? { states: [{ actions: main.actions, chapters, bookmarks, regions: main.regions, label: "Start" }], index: 0 });
    mainTimeline.current = null;
    setAdvanced(null);
    // Cancelled, an open tool goes too, unapplied.
    setTool(null);
    setBox(null);
    if (snippet) {
      if (done) saveSnippet(snippet.path ?? [name!], { actions: result, regions: made });
      setSelected(new Set());
      setLifted(null);
      setPlacing(null);
      return;
    }
    setSelected(new Set(done || instance ? [] : from));
    if (!done && instance) setRegionOn(instance);
    setLifted(done ? new Set(from) : null);
    setLiftedRegion(done ? instance : null);
    const shape = done ? clipBy({ actions: result, regions: instance ? [instanceOf(instance.snippet.name, { actions: result, regions: made })] : made }, -result[0].at) : null;
    if (shape) remember(shape);
    setPlacing(shape);
    if (done) {
      setPlaceAt(result[0]);
      setBoxMode(false);
    }
  };

  /** Whether the advanced editor's document differs from what it was opened on. */
  const advancedChanged = () => {
    const { actions: result, regions: made, from, zero, snippet } = advanced!;
    const instance = advanced!.instance === undefined ? null : (main.regions[advanced!.instance] as Instance);
    // Opened on points, it has no regions, so any is a change.
    const original = snippet ? snippetFrom(snippet.path, zero) : { actions: from?.map((i) => main.actions[i]) ?? [], regions: instance?.snippet.regions ?? [] };
    return JSON.stringify({ actions: result, regions: made }) !== JSON.stringify(original);
  };

  /** Whether the folder at `folder` has an entry named `name`. */
  const nameTaken = (folder: string[], name: string) => itemsAt(library, folder).some((e) => entryName(e) === name);

  /** Save `clip` to the library as the snippet at `path`, timed from its first point, in place of one there. */
  const saveSnippet = (path: string[], clip: Clip) => {
    const name = path[path.length - 1];
    const snippet: Snippet = { name, ...clipBy(clip, -clip.actions[0].at) };
    setLibrary((lib) => updatedAt(lib, path.slice(0, -1), (items) => [...items.filter((e) => entryName(e) !== name), snippet]));
  };

  /**
   * Insert the library snippet `s`: it follows the pointer until placed, as
   * a paste, or while its row is dragged until dropped on the graph; in the
   * main script as an instance, in the advanced editor as its points and
   * regions.
   */
  const insertSnippet = (s: Snippet) => {
    cancelPlacing();
    setPlacing({ actions: s.actions, regions: advanced ? generators(s.regions) : [instanceOf(s.name, s)] });
  };

  /** The open folders at `from` and in it, now at `to`. */
  const reopened = (from: string[], to: string[]) => setOpenFolders((keys) => keys.map((k) => {
    const p = JSON.parse(k) as string[];
    return under(p, from) ? JSON.stringify([...to, ...p.slice(from.length)]) : k;
  }));

  /** Add an empty folder `name` in the folder at `path`, and open that. */
  const addFolder = (path: string[], name: string) => {
    setLibrary((lib) => updatedAt(lib, path, (items) => [...items, { folder: name, items: [] }]));
    if (path.length) setOpenFolders((keys) => [...new Set([...keys, JSON.stringify(path)])]);
  };

  const renameEntry = (path: string[], name: string) => {
    const old = path[path.length - 1];
    setLibrary((lib) => updatedAt(lib, path.slice(0, -1), (items) => items.map((e) => (entryName(e) !== old ? e : isFolder(e) ? { ...e, folder: name } : { ...e, name }))));
    reopened(path, [...path.slice(0, -1), name]);
  };

  /** Delete the entry at `path`, a folder with its contents, once confirmed; an empty folder without asking. */
  const deleteEntry = (path: string[]) => {
    const [e, name] = [entryAt(library, path), path[path.length - 1]];
    const ask = !e ? null : !isFolder(e) ? `Delete the snippet ${name}?` : e.items.length ? `Delete the folder ${name} and everything in it?` : null;
    if (ask && !confirm(ask)) return;
    setLibrary((lib) => updatedAt(lib, path.slice(0, -1), (items) => items.filter((o) => entryName(o) !== name)));
  };

  /** Whether the entry at `from` may go into the folder at `to`: not where it is, not into itself, and not onto a name taken there. */
  const movable = (from: string[], to: string[]) => JSON.stringify(from.slice(0, -1)) !== JSON.stringify(to) && !under(to, from) && !nameTaken(to, from[from.length - 1]);

  const moveEntry = (from: string[], to: string[]) => {
    setLibrary((lib) => {
      const e = entryAt(lib, from)!;
      return updatedAt(updatedAt(lib, from.slice(0, -1), (items) => items.filter((o) => o !== e)), to, (items) => [...items, e]);
    });
    reopened(from, [...to, from[from.length - 1]]);
  };

  /** A library row or the panel's top area as a place to drop a dragged row into the folder at `to`, the top level for none; only in the main script. */
  const dropInto = (to: string[]) => advanced ? {} : {
    onPointerMove: () => rowDrag && movable(rowDrag.at, to) && setDropOn(JSON.stringify(to)),
    onPointerLeave: () => setDropOn(null),
    onPointerUp: () => rowDrag && movable(rowDrag.at, to) && moveEntry(rowDrag.at, to),
  };

  /**
   * Drag the library row of `entry` at `at` once the pointer moves from where
   * it was pressed: a snippet follows the pointer onto the graph, as a paste,
   * until released there or elsewhere.
   */
  const dragRow = (e: PointerEvent, at: string[], entry: Entry) => {
    if (e.button !== 0) return;
    const [x, y] = [e.clientX, e.clientY];
    let started = false;
    const move = (m: globalThis.PointerEvent) => {
      if (!started && Math.hypot(m.clientX - x, m.clientY - y) < 4) return;
      if (!started) {
        cancelPlacing();
        if (!isFolder(entry) && !tool) insertSnippet(entry);
      }
      started = true;
      setRowDrag({ at, x: m.clientX, y: m.clientY });
    };
    // After the row or graph under the pointer has taken it.
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!started) return;
      setRowDrag(null);
      setDropOn(null);
      setPlacing(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** The library as a file: every snippet and folder. */
  const exportLibrary = () => download(JSON.stringify(libraryFile), "snippets.json");

  /** Merge a library file into the library: folders of the same name merge, a taken name gets " (2)"; malformed entries go. */
  const importLibrary = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { ossmRsWebTools?: { snippets?: unknown } } | null;
      if (!Array.isArray(parsed?.ossmRsWebTools?.snippets)) throw new Error();
      const read = readEntries(parsed.ossmRsWebTools.snippets);
      setLibrary((lib) => merged(lib, read));
      setError(null);
    } catch {
      setError(`${file.name} is not a snippet library.`);
    }
  };

  /**
   * Switch selection mode. Entered with points selected, the box fits around
   * them, selecting the points in it; entered while moving, it places them
   * with the box around them.
   */
  const toggleBoxMode = () => {
    if (lifted && refused) return;
    setBoxMode(!boxMode);
    if (lifted) return drop(true);
    if (!boxMode && selected.size) {
      const picked = [...selected].map((i) => actions[i]);
      selectIn(boxed(picked.reduce(extended, spanned(picked[0], picked[0]))));
    } else setBox(null);
  };

  /** Drag the points being moved, from where they are shown. */
  const dragLifted = (e: PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = e.currentTarget.ownerSVGElement!;
    const [start, origin] = [ghost![0], pointerAt(e)];
    const move = (m: globalThis.PointerEvent) => {
      const p = pointerAt(m);
      setPlaceAt({ at: start.at + p.at - origin.at, pos: start.pos + p.pos - origin.pos });
    };
    track(svg, e, move);
  };

  /**
   * Start placing the points in funscript JSON, with the regions under our own
   * key: they follow the pointer until a click places them. False when it
   * holds no points.
   */
  const pasteJson = (text: string) => {
    let parsed: { actions?: unknown; ossmRsWebTools?: { regions?: unknown } } | null;
    try {
      parsed = JSON.parse(text);
    } catch {
      return false;
    }
    const clip = readClip(parsed?.actions, parsed?.ossmRsWebTools?.regions);
    if (!clip) return false;
    cancelPlacing();
    // In the advanced editor, instances come as their contents, as they do not nest.
    setPlacing(advanced ? { ...clip, regions: generators(clip.regions) } : clip);
    return true;
  };

  /**
   * The points being placed with the first at `at`, `pos`; they keep their
   * shape and stay within 0–100, and their regions from 0 on. Carrying
   * regions, they keep their depths, as the regions' boxes do.
   */
  const positioned = (at: number, pos: number, keepDepth: boolean) => {
    const { actions: shape, regions } = placing!;
    const lowest = Math.min(...shape.map((a) => a.pos));
    const highest = Math.max(...shape.map((a) => a.pos));
    const dp = keepDepth || regions.length ? 0 : clamp(pos - shape[0].pos, -lowest, 100 - highest);
    const first = Math.max(at, 0, ...regions.map((r) => -r.from));
    return shape.map((a) => ({ at: first + a.at, pos: a.pos + dp }));
  };

  /** The regions the points being placed carry, with the first point at `pasted`'s. */
  const carriedBy = (pasted: Action[]) => placing!.regions.map((r) => movedBy(r, pasted[0].at));
  /**
   * `pasted` with the Markers regions they carry, also in instances, put
   * again on the bookmarks under them: none without any there; as they are
   * while a setup is refused. Placed from `pasted`'s first point, as before.
   */
  const filledIn = (pasted: Action[]) => markersRegions(carriedBy(pasted))
    .reduce((list, r) => refilled(list, r, bookmarks), pasted);

  /** The time `pasted` covers, with the regions they carry. */
  const spanOf = (pasted: Action[]) => {
    const carried = carriedBy(pasted);
    return [Math.min(pasted[0].at, ...carried.map((r) => r.from)), Math.max(pasted[pasted.length - 1].at, ...carried.map((r) => r.to))];
  };

  /**
   * The existing points and regions before and after `pasted` once placed.
   * Inserting moves the points from the first pasted one on right by the
   * pasted length, so the gap that followed stays, and at least 1 ms past the
   * last pasted point, and the regions there with them, a Markers one's points
   * going on the bookmarks in its new box. Replacing drops the points in the
   * time `pasted` covers. Both with the regions they carry.
   */
  const around = (pasted: Action[], insert: boolean) => {
    const [start, end] = spanOf(pasted);
    const before = kept.slice(0, byTime(kept, start));
    if (!insert) return { before, after: kept.slice(afterTime(kept, end)), regions: keptRegions };
    const later = kept.slice(before.length);
    // The first point or region moved goes at least 1 ms past them.
    const next = Math.min(later[0]?.at ?? Infinity, ...keptRegions.filter((r) => r.from >= start).map((r) => r.from));
    const shift = Number.isFinite(next) ? Math.max(end - start, end + 1 - next) : 0;
    const regions = keptRegions.map((r) => (r.from >= start ? movedBy(r, shift) : r));
    const shifted = shift ? markersRegions(regions).filter((r) => r.from >= start + shift) : [];
    const after = shifted.reduce((list, r) => refilled(list, r, bookmarks), later.map((a) => ({ at: a.at + shift, pos: a.pos })));
    return { before, after, regions };
  };

  /** Whether `pasted` may not go in: replacing, it or a region it carries would cover part of a region; inserting, it would split one. */
  const refuses = (pasted: Action[], insert: boolean) => {
    const [start, end] = spanOf(pasted);
    return keptRegions.some((r) => (insert ? r.from < start && start <= r.to : r.from <= end && r.to >= start));
  };

  // Track the modifiers while placing; pointer events correct them if they were pressed before.
  useEffect(() => {
    setHeld({ shift: false, ctrl: false });
    if (!placing) return;
    const key = (e: KeyboardEvent) => setHeld({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
    const blur = () => setHeld({ shift: false, ctrl: false });
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", blur);
    };
  }, [placing]);

  /**
   * Put `pasted` into the script, inserting or replacing, with the regions
   * they carry, each with its own copy of the setup, and select them: the
   * points but the regions', or a region pasted alone. Returns the new points.
   */
  const put = (pasted: Action[], insert: boolean) => {
    const { before, after, regions } = around(pasted, insert);
    const carried = carriedBy(pasted).map((r) => structuredClone(r));
    const placed = filledIn(pasted);
    // Nothing lifted, the advanced editor's result from empty is new, as a paste.
    editLabel.current = lifted && liftedRegion ? `Edit ${regionNoun(liftedRegion)}` : `${lifted?.size ? "Move" : insert ? "Insert" : "Paste"} ${lifted?.size || !carried.length ? points(placed.length) : carried.length === 1 ? regionNoun(carried[0]) : `${carried.length} regions`}`;
    const next = [...before, ...placed, ...after];
    setScript({ ...script, actions: next, regions: carried.length ? [...regions, ...carried].sort((a, b) => a.from - b.from) : regions });
    setSelected(new Set(placed.flatMap((a, i) => (regionAt(carried, a.at) ? [] : [before.length + i]))));
    if (carried.length === 1 && placed.every((a) => regionAt(carried, a.at))) selectRegion(carried[0]);
    setPlacing(null);
    setLifted(null);
    return next;
  };

  /** Place the points being moved where they were dragged, unless refused there; `boxIn` for selection mode, with the box around them. */
  const drop = (boxIn = false) => {
    if (refused) return;
    const moved = ghost!;
    const next = put(moved, inserting);
    if (boxIn) setBox(boxed(moved.reduce(extended, spanned(moved[0], moved[0]))), next);
  };

  /** A click places pasted points at the pointer; outside their box, it places the points being moved. Not where they are refused. */
  const place = (e: PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (lifted) return drop();
    const [pasted, insert] = pastedAt(e);
    if (!refuses(pasted, insert)) put(pasted, insert);
  };

  /** The pasted points at the pointer, and whether they would insert, by the modifiers held. */
  const pastedAt = (e: { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const point = pointerAt(e);
    return [positioned(point.at, point.pos, e.ctrlKey || e.metaKey), insertMode !== e.shiftKey] as const;
  };

  /** The toolbox buttons go through the Clipboard API, which may ask for permission to paste. */
  const copyButton = async (cutting: boolean) => {
    try {
      await navigator.clipboard.writeText(selectionJson());
      if (cutting) cut();
      setError(null);
    } catch (e) {
      setError(`Copying failed: ${(e as Error).message}`);
    }
  };
  const pasteButton = async () => {
    try {
      setError(pasteJson(await navigator.clipboard.readText()) ? null : "The clipboard holds no funscript points.");
    } catch (e) {
      setError(`Pasting failed: ${(e as Error).message}`);
    }
  };

  // Ctrl+C, Ctrl+X and Ctrl+V on the system clipboard; not while typing in a field.
  const copy = (e: ClipboardEvent) => {
    if (e.target instanceof HTMLInputElement || !copyable || (tool && e.type === "cut")) return;
    e.preventDefault();
    e.clipboardData!.setData("text/plain", selectionJson());
    if (e.type === "cut") cut();
  };
  useWindowEvent("copy", copy);
  useWindowEvent("cut", copy);
  useWindowEvent("paste", (e) => {
    if (e.target instanceof HTMLInputElement || tool) return;
    if (pasteJson(e.clipboardData!.getData("text/plain"))) e.preventDefault();
  });

  const open = async (file: File) => {
    try {
      const parsed = await readFunscript(file);
      // Read again for the rest of the file, already known to be JSON.
      const { actions: _, ...rest } = JSON.parse(await file.text()) as Record<string, unknown>;
      setLifted(null);
      setSelected(new Set());
      setMarked(new Set());
      editLabel.current = `Open ${file.name}`;
      const opened = Array.from(parsed.at, (at, i) => ({ at, pos: parsed.pos[i] }));
      const markers = readMarkers(rest, Math.max(opened[opened.length - 1].at, videoDuration));
      // Taken as they are, never generated again.
      const regions = readRegions((rest.ossmRsWebTools as { regions?: unknown } | null | undefined)?.regions);
      const next = { name: file.name.replace(/\.funscript$/, ""), actions: opened, file: rest, ...markers, regions };
      setSaved(next);
      setScript(next);
      setView((v) => ({ ...v, from: 0 }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = () => {
    const { file = {} } = script;
    // Into the opened file's metadata; the lists only when there are markers or the file had them.
    const metadata = { ...(file.metadata as Record<string, unknown> | undefined) };
    if (chapters.length || "chapters" in metadata) {
      metadata.chapters = [...chapters].sort((a, b) => a.start - b.start).map(({ start, end, ...rest }) => ({ ...rest, startTime: writeTime(start), endTime: writeTime(end) }));
    }
    if (bookmarks.length || "bookmarks" in metadata) {
      metadata.bookmarks = [...bookmarks].sort((a, b) => a.time - b.time).map(({ time, ...rest }) => ({ ...rest, time: writeTime(time) }));
    }
    // Into the opened file's "ossmRsWebTools", our own key; the regions only when there are some or the file had them.
    const ossmRsWebTools = { ...(file.ossmRsWebTools as Record<string, unknown> | undefined) };
    if (regions.length || "regions" in ossmRsWebTools) Object.assign(ossmRsWebTools, { version: 1, regions: [...regions].sort((a, b) => a.from - b.from) });
    const json = JSON.stringify({
      version: "1.0",
      inverted: false,
      range: 100,
      ...file,
      actions,
      ...(Object.keys(metadata).length || "metadata" in file ? { metadata } : {}),
      ...(Object.keys(ossmRsWebTools).length || "ossmRsWebTools" in file ? { ossmRsWebTools } : {}),
    });
    download(json, `${script.name || "untitled"}.funscript`);
    setSaved(script);
  };

  /** The points being placed where they would go. */
  const ghost = placing && placeAt ? positioned(placeAt.at, placeAt.pos, held.ctrl) : null;
  /** The time they cover with the regions they carry, which show with them. */
  const ghostSpan = ghost && spanOf(ghost);
  const ghostRegions = ghost ? carriedBy(ghost) : [];
  /** Their points as they would go in, their Markers regions' on the bookmarks under them. */
  const ghostPoints = ghost && filledIn(ghost);
  /** Whether placing them there is refused, as it would cut into a region; they show red. */
  const refused = !!ghost && refuses(ghost, inserting);
  /** Whether a point at `at` would be replaced by them. */
  const replaced = (at: number) => !!ghostSpan && !inserting && at >= ghostSpan[0] && at <= ghostSpan[1];
  /** The points as drawn: while inserting, the later ones where they would move. Same order and indices as `kept`. */
  const moved = ghost && inserting ? around(ghost, true) : null;
  const shown = moved ? [...moved.before, ...moved.after] : preview?.actions ?? kept;
  /** The regions as drawn, with the points. */
  const shownRegions = moved?.regions ?? preview?.regions ?? keptRegions;
  /** The selected points as drawn: with a tool open, the affected ones in its result. */
  const marks = preview?.selected ?? selected;
  /** The points being placed joined to the existing points they would sit between. */
  const neighbours = ghost && (moved ?? around(ghost, false));
  const ghostLine = ghostPoints && [neighbours!.before[neighbours!.before.length - 1], ...ghostPoints, neighbours!.after[0]].filter((a) => a !== undefined);

  // The points in view and one beyond each edge, so the line reaches the edges.
  const first = Math.max(byTime(shown, view.from) - 1, 0);
  const last = Math.min(byTime(shown, view.from + view.span) + 1, shown.length);
  const visible = shown.slice(first, last);
  /** The line through the points, broken where the points being placed go so they can join it. */
  const segments = ghost ? [visible.filter((a) => a.at < ghost[0].at), visible.filter((a) => a.at > ghost[ghost.length - 1].at)] : [visible];
  /** The index of the point under the pointer, the one drawn on top if several, or null. */
  const pointUnder = (e: { clientX: number; clientY: number }) => {
    const rect = boxRef.current!.getBoundingClientRect();
    const [px, py] = [e.clientX - rect.left, e.clientY - rect.top];
    const near = (dx: number) => byTime(visible, view.from + ((px + dx) / width) * view.span);
    // Selected points are drawn last, on top.
    let hit = null;
    for (let j = near(-8); j < near(8); j++) {
      const i = first + j;
      if (replaced(visible[j].at) || regionAt(shownRegions, visible[j].at) || Math.hypot(x(visible[j].at) - px, y(visible[j].pos) - py) > (selected.has(i) ? 8 : 5)) continue;
      if (hit === null || selected.has(i) || !selected.has(hit)) hit = i;
    }
    return hit;
  };

  // The line and points are drawn on a canvas: as SVG, thousands of them in view make scrolling and zooming lag.
  useLayoutEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      [canvas.width, canvas.height] = [Math.round(width * dpr), Math.round(height * dpr)];
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const css = getComputedStyle(canvas);
    Object.assign(ctx, { lineWidth: 2, lineJoin: "round", strokeStyle: css.getPropertyValue("--gray-a7") });
    for (const run of context) {
      ctx.beginPath();
      for (const a of run.slice(Math.max(byTime(run, view.from) - 1, 0), byTime(run, view.from + view.span) + 1)) ctx.lineTo(x(a.at), y(a.pos));
      ctx.stroke();
    }
    // With a tool open, the points it was opened on, faint and dashed behind its result; Repeat's only in its pattern box.
    if (tool) {
      ctx.save();
      Object.assign(ctx, { lineWidth: 1.5, strokeStyle: css.getPropertyValue("--gray-a9") });
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      const all = tool.actions;
      const a = tool.kind !== "repeat" ? all : repParams ? all.slice(byTime(all, repBox.from), afterTime(all, repBox.from + repParams.length)) : [];
      for (const p of a.slice(Math.max(byTime(a, view.from) - 1, 0), byTime(a, view.from + view.span) + 1)) ctx.lineTo(x(p.at), y(p.pos));
      ctx.stroke();
      ctx.restore();
    }
    Object.assign(ctx, { strokeStyle: LINE_COLOR, fillStyle: LINE_COLOR });
    // Repeat's copies show thin and faded, so its pattern's line stands out; the line breaks between them, to be drawn over.
    const muted = tool?.kind === "repeat" && !ghost;
    const between = (j: number) => marks.has(first + j - 1) && marks.has(first + j);
    for (const segment of segments) {
      ctx.beginPath();
      segment.forEach((a, j) => (muted && between(j) ? ctx.moveTo(x(a.at), y(a.pos)) : ctx.lineTo(x(a.at), y(a.pos))));
      ctx.stroke();
    }
    // The line through selected points is drawn over; a short run of them in view also shows rings, so zoomed in, a long run's part in view does too.
    const long = new Array<boolean>(visible.length).fill(false);
    for (let j = 0; j < visible.length; ) {
      let end = j;
      while (end < visible.length && marks.has(first + end)) end++;
      if (end - j > RING_LIMIT) long.fill(true, j, end);
      j = Math.max(end, j + 1);
    }
    const line = new Path2D();
    for (let j = 1; j < visible.length; j++) {
      const [a, b] = [visible[j - 1], visible[j]];
      if (!between(j) || replaced(a.at) || replaced(b.at)) continue;
      line.moveTo(x(a.at), y(a.pos));
      line.lineTo(x(b.at), y(b.pos));
    }
    ctx.strokeStyle = css.getPropertyValue("--gray-12");
    ctx.save();
    if (muted) Object.assign(ctx, { lineWidth: 1.5, globalAlpha: 0.45 });
    ctx.stroke(line);
    ctx.restore();
    // Packed this close, the points would only blur the line; a tool's result only shows its line, as its points can't be dragged.
    const showDots = !tool && visible.length * DOT_SPACING < width;
    // One path per look, so drawing stays fast however many points there are. The points being replaced show as small crosses.
    const [dots, ringed, crosses] = [new Path2D(), new Path2D(), new Path2D()];
    visible.forEach((a, j) => {
      const [cx, cy] = [x(a.at), y(a.pos)];
      if (replaced(a.at)) {
        crosses.moveTo(cx - 3, cy - 3);
        crosses.lineTo(cx + 3, cy + 3);
        crosses.moveTo(cx + 3, cy - 3);
        crosses.lineTo(cx - 3, cy + 3);
        return;
      }
      const ring = !tool && marks.has(first + j) && !long[j];
      // The regions' points only show their line.
      if ((!ring && !showDots) || regionAt(shownRegions, a.at)) return;
      const path = ring ? ringed : dots;
      const r = ring ? 7 : 5;
      path.moveTo(cx + r, cy);
      path.arc(cx, cy, r, 0, 2 * Math.PI);
    });
    ctx.fill(dots);
    ctx.fill(ringed);
    ctx.strokeStyle = css.getPropertyValue("--gray-12");
    ctx.stroke(ringed);
    Object.assign(ctx, { lineWidth: 1.5, strokeStyle: css.getPropertyValue("--red-9") });
    ctx.stroke(crosses);
    // A dragged region over another, its points red.
    if (astray) {
      ctx.save();
      Object.assign(ctx, { globalAlpha: 0.6, lineWidth: 2, strokeStyle: css.getPropertyValue("--red-9") });
      ctx.beginPath();
      for (const a of astray.actions) ctx.lineTo(x(a.at), y(a.pos));
      ctx.stroke();
      ctx.restore();
    }
    // The points a dragged region covers, faded.
    if (covered.length) {
      ctx.save();
      Object.assign(ctx, { globalAlpha: 0.3, fillStyle: LINE_COLOR });
      const faded = new Path2D();
      for (const a of covered.slice(byTime(covered, view.from), afterTime(covered, view.from + view.span))) {
        faded.moveTo(x(a.at) + 5, y(a.pos));
        faded.arc(x(a.at), y(a.pos), 5, 0, 2 * Math.PI);
      }
      ctx.fill(faded);
      ctx.restore();
    }
    // The points being placed, faded, over the rest; only those in view, as a selection to move can be the whole script.
    if (ghostLine) {
      ctx.save();
      const color = refused ? css.getPropertyValue("--red-9") : LINE_COLOR;
      Object.assign(ctx, { globalAlpha: 0.6, lineWidth: 2, strokeStyle: color, fillStyle: color });
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      const [l0, l1] = [Math.max(byTime(ghostLine, view.from) - 1, 0), Math.min(byTime(ghostLine, view.from + view.span) + 1, ghostLine.length)];
      for (let j = l0; j < l1; j++) ctx.lineTo(x(ghostLine[j].at), y(ghostLine[j].pos));
      ctx.stroke();
      const ghostDots = new Path2D();
      const r = (5 / width) * view.span;
      for (const a of ghostPoints!.slice(byTime(ghostPoints!, view.from - r), afterTime(ghostPoints!, view.from + view.span + r))) {
        const [cx, cy] = [x(a.at), y(a.pos)];
        if (regionAt(ghostRegions, a.at)) continue;
        ghostDots.moveTo(cx + 5, cy);
        ghostDots.arc(cx, cy, 5, 0, 2 * Math.PI);
      }
      ctx.fill(ghostDots);
      ctx.restore();
    }
  });
  /** The selection box's sides, in px. */
  const edges = box && { from: x(box.from), to: x(box.to), low: y(box.low), high: y(box.high) };
  /**
   * Buttons in the middle of the selection box's edges, in its part in view,
   * that grow it to the start or end of the script, or the top or bottom; each
   * only while that edge is not there yet. None in a box too small for them.
   */
  const extenders = (() => {
    if (!boxMode || placing || !box || !edges) return [];
    const [left, right] = [Math.max(edges.from, 0), Math.min(edges.to, width)];
    const [midX, midY] = [(left + right) / 2 - EXTEND / 2, (edges.high + edges.low) / 2 - EXTEND / 2];
    if (right - left < 3 * EXTEND + 16 || edges.low - edges.high < 3 * EXTEND + 16) return [];
    return ([
      ["Extend the selection to the start", DoubleArrowLeftIcon, { from: 0 }, box.from > 0, left + 6, midY],
      ["Extend the selection to the end", DoubleArrowRightIcon, { to: end }, box.to < end, right - 6 - EXTEND, midY],
      ["Extend the selection to the top", DoubleArrowUpIcon, { high: 100 }, box.high < 100, midX, edges.high + 6],
      ["Extend the selection to the bottom", DoubleArrowDownIcon, { low: 0 }, box.low > 0, midX, edges.low - 6 - EXTEND],
    ] as const).filter(([, , , shown]) => shown);
  })();

  /**
   * The library's rows in the folder at `path`, `depth` deep, an open
   * folder's rows after it. In the main script a row is dragged onto a folder
   * row to move it there, and has Rename and Delete; a folder's New folder, a
   * snippet's Edit. Everywhere a snippet's row is dragged onto the graph to
   * insert it.
   */
  const libraryRows = (items: Entry[], path: string[], depth: number): ReactElement[] => sortedEntries(items).flatMap((e) => {
    const [name, at] = [entryName(e), [...path, entryName(e)]];
    const key = JSON.stringify(at);
    const open = isFolder(e) && (!!snippetQuery || openFolders.includes(key));
    const toggle = () => setOpenFolders((keys) => (open ? keys.filter((k) => k !== key) : [...keys, key]));
    const row = (
      <Flex
        key={key}
        align="center"
        gap="1"
        onPointerDown={!advanced || !isFolder(e) ? (p) => dragRow(p, at, e) : undefined}
        {...(isFolder(e) ? dropInto(at) : {})}
        style={{ paddingLeft: depth * 16, minHeight: 28, borderRadius: 4, userSelect: "none", background: dropOn === key ? "var(--accent-a4)" : undefined }}
      >
        {/* A snippet's name shows a preview beside the panel: its points, its regions' boxes behind, its length and point count. */}
        <HoverCard.Root openDelay={300} closeDelay={0} open={isFolder(e) ? false : undefined}>
          <HoverCard.Trigger>
            <Flex
              align="center"
              gap="2"
              flexGrow="1"
              minWidth="0"
              onClick={isFolder(e) ? toggle : undefined}
              onDoubleClick={() => !isFolder(e) && !tool && insertSnippet(e)}
              style={{ cursor: isFolder(e) ? "pointer" : undefined, userSelect: "none" }}
            >
              {isFolder(e) ? <ChevronRightIcon style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined }} /> : <ComponentInstanceIcon style={{ flexShrink: 0 }} />}
              <Text size="2" truncate>{name}</Text>
            </Flex>
          </HoverCard.Trigger>
          {!isFolder(e) && (
            <HoverCard.Content side="left" size="1">
              <Flex direction="column" gap="1">
                <PreviewGraph pieces={[{ kind: "plain", points: e.actions }]} bands={generators(e.regions)} />
                <Text size="1" color="gray">{formatScriptTime(e.actions[e.actions.length - 1].at / 1000)} · {points(e.actions.length)}</Text>
              </Flex>
            </HoverCard.Content>
          )}
        </HoverCard.Root>
        {!advanced && isFolder(e) && (
          <NamePopover taken={(n) => nameTaken(at, n)} onName={(n) => addFolder(at, n)}>
            <IconButton size="1" variant="ghost" color="gray" aria-label="New folder in it" title="New folder in it"><PlusIcon /></IconButton>
          </NamePopover>
        )}
        {!advanced && !isFolder(e) && (
          <IconButton size="1" variant="ghost" color="gray" disabled={!!placing} aria-label="Edit" title="Edit it in the advanced editor" onClick={() => openAdvanced({ path: at })}><MixerHorizontalIcon /></IconButton>
        )}
        {!advanced && <>
          <NamePopover initial={name} taken={(n) => n !== name && nameTaken(path, n)} onName={(n) => n !== name && renameEntry(at, n)}>
            <IconButton size="1" variant="ghost" color="gray" aria-label="Rename" title="Rename"><Pencil1Icon /></IconButton>
          </NamePopover>
          <IconButton size="1" variant="ghost" color="red" aria-label="Delete" title={isFolder(e) ? "Delete it with its contents" : "Delete"} onClick={() => deleteEntry(at)}><TrashIcon /></IconButton>
        </>}
      </Flex>
    );
    return [row, ...(open ? libraryRows((e as Folder).items, at, depth + 1) : [])];
  });

  const shownLibrary = snippetQuery ? matching(library, snippetQuery) : library;
  /** The Snippets panel, beside the graph: the library as a tree; in the main script, its top area takes rows dropped to the top level. */
  const snippetsPanel = <Flex direction="column" gap="3" p="3">
    <Flex direction="column" gap="2" {...dropInto([])} style={{ borderRadius: 4, background: dropOn === "[]" ? "var(--accent-a4)" : undefined }}>
      <Text size="2" weight="medium">Snippets</Text>
      {!advanced && <Flex gap="2" wrap="wrap">
        <Button size="1" variant="soft" color="gray" disabled={!!placing} title="Make a snippet in the advanced editor" onClick={() => openAdvanced({ path: null })}>
          <PlusIcon /> New snippet
        </Button>
        <NamePopover taken={(n) => nameTaken([], n)} onName={(n) => addFolder([], n)}>
          <Button size="1" variant="soft" color="gray"><PlusIcon /> New folder</Button>
        </NamePopover>
        <Button size="1" variant="soft" color="gray" disabled={!library.length} title="Save the library to a file" onClick={exportLibrary}>
          <DownloadIcon /> Export
        </Button>
        <Button size="1" variant="soft" color="gray" title="Merge a library file into the library" onClick={() => libraryInput.current?.click()}>
          <UploadIcon /> Import
        </Button>
      </Flex>}
      {!!library.length && (
        <TextField.Root size="1" placeholder="Search" aria-label="Search snippets" value={snippetQuery} onChange={(e) => setSnippetQuery(e.target.value)}>
          <TextField.Slot><MagnifyingGlassIcon /></TextField.Slot>
        </TextField.Root>
      )}
    </Flex>
    <Flex direction="column">
      {shownLibrary.length ? libraryRows(shownLibrary, [], 0) : <Text size="1" color="gray">{library.length ? "No matches." : "No snippets yet."}</Text>}
    </Flex>
    {/* The dragged row's icon and name follow the pointer. */}
    {rowDrag && (
      <Flex align="center" gap="2" style={{ position: "fixed", left: rowDrag.x + 12, top: rowDrag.y + 12, pointerEvents: "none", zIndex: 1 }}>
        {entryAt(library, rowDrag.at) && isFolder(entryAt(library, rowDrag.at)!) ? <ChevronRightIcon /> : <ComponentInstanceIcon />}
        <Text size="2">{rowDrag.at[rowDrag.at.length - 1]}</Text>
      </Flex>
    )}
  </Flex>;

  /** The advanced editor's Done, as `label`. In snippet mode, it saves to the library, a new snippet under a name, so it needs a length. */
  const doneButton = (label: string) => advanced && (advanced.snippet && !advanced.snippet.path ? (
    <NamePopover taken={(n) => nameTaken([], n)} onName={(n) => closeAdvanced(true, n)}>
      <Button style={{ flex: 1 }} disabled={actions.length < 2}>{label}</Button>
    </NamePopover>
  ) : (
    <Button style={{ flex: 1 }} disabled={actions.length < (advanced.snippet || advanced.instance !== undefined ? 2 : 1)} onClick={() => closeAdvanced(true)}>{label}</Button>
  ));

  /** What the advanced editor is editing, in place of the script's name. */
  const advancedTitle = advanced && (advanced.instance !== undefined ? `Snippet · ${(main.regions[advanced.instance] as Instance).snippet.name}` : !advanced.snippet ? "Advanced editor" : advanced.snippet.path ? `Snippet · ${advanced.snippet.path[advanced.snippet.path.length - 1]}` : "New snippet");

  /** Send the points to the player, which loads them at once in other tabs and here on switching to it; the advanced editor's from 0. */
  const sendToPlayer = () => {
    const sent = advanced ? actions.map((a) => ({ ...a, at: a.at - actions[0].at })) : actions;
    localStorage.setItem(SENT_SCRIPT_KEY, JSON.stringify({ name: advancedTitle || script.name || "untitled", actions: sent, sent: Date.now() }));
  };

  /** Show the time `t` ms: the view centred on it when it is out of view, and the playhead there. */
  const goTo = (t: number) => {
    if (t < view.from || t > view.from + view.span) setView({ ...view, from: clamp(t - view.span / 2, 0, Math.max(total - view.span, 0)) });
    seek(t);
  };

  /**
   * The Markers panel, beside the graph: the chapters and bookmarks in time,
   * the selected ones marked. A click on one shows it, and selects it;
   * bookmarks are selected together as on the lane. A double-click renames
   * it. The advanced editor's document has no markers of its own, so there
   * they only show their times.
   */
  const markerRow = (m: Marker, key: string) => (
    <Flex
      key={key}
      align="center"
      gap="2"
      px="1"
      onClick={(e) => {
        if (!advanced && markerPicked(e, m)) return;
        if (!advanced) {
          markerAnchor.current = m;
          selectMarkers([m]);
        }
        goTo(timeOf(m));
      }}
      onDoubleClick={() => !advanced && rename([m])}
      style={{ minHeight: 28, borderRadius: 4, cursor: "pointer", userSelect: "none", background: marked.has(m) ? "var(--accent-a4)" : undefined }}
    >
      {/* A bookmark's colour, as its flag in the lane. */}
      {!isChapter(m) && <Box flexShrink="0" width="8px" height="8px" style={{ borderRadius: "50%", background: `var(--${markerColor(m.name)}-9)` }} />}
      <Text size="2" truncate style={{ flexGrow: 1 }}>{m.name}</Text>
      <Text size="1" color="gray" style={{ flexShrink: 0 }}>
        {isChapter(m) ? `${formatScriptTime(m.start / 1000)}–${formatScriptTime(m.end / 1000)}` : formatScriptTime(m.time / 1000)}
      </Text>
    </Flex>
  );
  const markersPanel = <Flex direction="column" gap="3" p="3">
    <Text size="2" weight="medium">Chapters</Text>
    <Flex direction="column">
      {chapters.length ? chapters.map((c, i) => markerRow(c, `c${i}`)) : <Text size="1" color="gray">No chapters. Drag along the lane under the graph to draw one.</Text>}
    </Flex>
    <Text size="2" weight="medium">Bookmarks</Text>
    <Flex direction="column">
      {bookmarks.length ? bookmarks.map((b, i) => markerRow(b, `b${i}`)) : <Text size="1" color="gray">No bookmarks. Click the lane under the graph, or press B, to add one.</Text>}
    </Flex>
  </Flex>;

  /**
   * The open tool's functions as parts of its panel: those of its `timing`,
   * shown with the Timing part, then Out and In, each its own part,
   * collapsed to a header with its shape; expanded, its shape, then its
   * fields, two to a row, values in the function's unit, Speed's none, as Max
   * speed's.
   */
  const funcParts = (timing: [FuncKey, string, string][]) => ([...timing, ["out", "Out", "%"], ["in", "In", "%"]] as [FuncKey, string, string][])
    .filter(([key]) => !ownScale(key) || genPart === "timing")
    .map(([key, label, unit]) => {
      const func = fnSetup[key]!;
      // Out and In as parts, collapsed to a header with their shape.
      const part = key === "out" || key === "in";
      const set = (next: Func) => setFunc(key, () => next);
      /** Periods and Interval's values: kept in whole ms, shown in s, above 0. */
      const inSeconds = (field: ShapeField) => field === "period" || (key === "interval" && SPANNED.includes(field));
      const shapeSelect = (
        <Select.Root size="1" value={func.shape} onValueChange={(v) => set(part
          ? reshaped(func, v as Shape, undefined, key === "out" ? extent(fnSetup.in!)[0] : extent(fnSetup.out!)[1])
          : reshaped(func, v as Shape, typed((tool?.kind === "repeat" ? REPEAT_DEFAULTS.time : GENERATE_DEFAULTS[key as "interval"]).value ?? "")))}>
          <Select.Trigger aria-label={`${label} shape`} />
          <Select.Content>
            {/* Each with a small graph, which the trigger shows too. */}
            {Object.entries(SHAPES).map(([shape, { name, graph }]) => (
              <Select.Item key={shape} value={shape}>
                <Flex gap="2" align="center">
                  <svg width="32" height="16" viewBox="0 0 32 16" fill="none" strokeWidth={1.5} strokeLinejoin="round">
                    <polyline points={graph} stroke={LINE_COLOR} />
                  </svg>
                  {name}
                </Flex>
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      );
      if (part && genPart !== key) return (
        <Box key={key}>
          {partHeader(key, label, <>
            <svg width="32" height="16" viewBox="0 0 32 16" fill="none" strokeWidth={1.5} strokeLinejoin="round" style={{ verticalAlign: "middle", marginRight: 4 }}>
              <polyline points={SHAPES[func.shape].graph} stroke={LINE_COLOR} />
            </svg>
            {SHAPES[func.shape].name}
          </>)}
        </Box>
      );
      return (
        <Flex key={key} direction="column" gap="2">
          {part ? partHeader(key, label, shapeSelect) : (
            <Flex gap="2" align="center" justify="between">
              <Text size="2">{label}</Text>
              {shapeSelect}
            </Flex>
          )}
          <Text size="1" color="gray">
            Drag its handles in the {part ? "graph" : "view below the graph"}
            {func.shape === "spline" ? "; click its line to add a knot, double-click one to remove it." : "."}
          </Text>
          <Flex gap="2" wrap="wrap">
            {/* An Interval, Speed or Time spline's scale too. */}
            {[...SHAPES[func.shape].fields, ...(func.shape !== "spline" || func.max === undefined ? [] : (["min", "max"] as const))].map((field) => (
              <TextField.Root
                key={field}
                type="number"
                // Interval's and a period's seconds by tenths with the wheel and arrows; typed, any.
                step={inSeconds(field) ? 0.1 : "any"}
                aria-label={`${label} ${field}`}
                // Shown in s: a number, so React leaves what is being typed ("0.0") alone.
                value={inSeconds(field) ? (Number.isFinite(typed(func[field] ?? "")) ? typed(func[field]!) / 1000 : "") : func[field] ?? ""}
                onChange={(e) => set({ ...func, [field]: inSeconds(field) && e.target.value ? String(Math.round(Number(e.target.value) * 1000)) : e.target.value })}
                // Not typed negative; the wheel and arrows keep them to 0.1 or more.
                min={inSeconds(field) ? 0.1 : undefined}
                onKeyDown={(e) => inSeconds(field) && e.key === "-" && e.preventDefault()}
                style={{ flex: "1 1 40%", minWidth: 0 }}
              >
                <TextField.Slot side="left">{{ value: "Value", start: "Start", end: "End", min: "Min", max: "Max", period: "Period", phase: "Phase", width: "Width", seed: "Seed" }[field]}</TextField.Slot>
                <TextField.Slot side="right">
                  {field === "seed" ? (
                    <IconButton size="1" variant="ghost" color="gray" aria-label="Reroll" title="Reroll" onClick={() => set({ ...func, seed: newSeed() })}>
                      <ShuffleIcon />
                    </IconButton>
                  ) : { period: "s", phase: "%", width: "%" }[field as string] ?? unit}
                </TextField.Slot>
              </TextField.Root>
            ))}
          </Flex>
          {func.period !== undefined && !(typed(func.period) > 0) && <Text size="1" color="red">Period must be above 0.</Text>}
          {(key === "interval" || key === "time") && SPANNED.some((f) => func[f] !== undefined && !(typed(func[f]) > 0)) && <Text size="1" color="red">{label} must be above 0.</Text>}
        </Flex>
      );
    });

  const sidebar = (
    // At least the panel's height, so the buttons docked at its bottom sit there.
    <Flex direction="column" gap="3" p="3" minHeight="100%">
      <input
        ref={input}
        type="file"
        accept=".funscript"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void open(file);
          e.target.value = "";
        }}
      />
      {/* The advanced editor's document is not a file of its own: in its place, what is being edited; how to leave is at the bottom. */}
      {advanced && <Heading size="4" truncate>{advancedTitle}</Heading>}
      {!advanced && <Flex gap="2">
        <Button
          variant="soft"
          style={{ flex: 1 }}
          onClick={() => {
            if ((actions.length || chapters.length || bookmarks.length) && !confirm("Discard the current script?")) return;
            setLifted(null);
            setSelected(new Set());
            setMarked(new Set());
            editLabel.current = "New script";
            setSaved(EMPTY);
            setScript(EMPTY);
            setView((v) => ({ ...v, from: 0 }));
          }}
        >
          <FileIcon /> New
        </Button>
        <Button variant="soft" style={{ flex: 1 }} onClick={() => input.current?.click()}>
          <UploadIcon /> Open
        </Button>
      </Flex>}
      <input
        ref={libraryInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importLibrary(file);
          e.target.value = "";
        }}
      />
      <input
        ref={videoInput}
        type="file"
        accept="video/*,audio/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            setPaused(true);
            setTime(0);
            setVideoFile(file);
            setPlayerShown(true);
          }
          e.target.value = "";
        }}
      />
      {!tool && <Flex gap="2">
        <Button variant="soft" style={{ flex: 1 }} onClick={() => videoInput.current?.click()}>
          <VideoIcon /> {videoFile ? "Change media" : "Open video or audio"}
        </Button>
        {videoFile && (
          <Button
            variant="soft"
            color="gray"
            onClick={() => {
              setPaused(true);
              setVideoFile(null);
            }}
          >
            <Cross2Icon /> Close
          </Button>
        )}
      </Flex>}
      {!advanced && <>
      <Box>
        <Text as="label" size="2" weight="medium" mb="1" style={{ display: "block" }} htmlFor="editor-name">Name</Text>
        <TextField.Root id="editor-name" value={script.name} onChange={(e) => setScript({ ...script, name: e.target.value })}>
          {videoFile && (
            <TextField.Slot side="right">
              <IconButton
                size="1"
                variant="ghost"
                aria-label="Name after the media"
                title="Name after the media"
                onClick={() => setScript({ ...script, name: videoFile.name.replace(/\.[^.]+$/, "") })}
              >
                <VideoIcon />
              </IconButton>
            </TextField.Slot>
          )}
        </TextField.Root>
      </Box>
      <Button disabled={actions.length < 2} onClick={save}>
        <DownloadIcon /> Save
      </Button>
      </>}
      {error && (
        <Callout.Root color="red" size="1">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      {/* With a tool open, the panel only has the tool. */}
      {!tool && <>
      <Text size="2" color="gray">
        {actions.length} points{selected.size > 1 && ` · ${selected.size} selected`} · {formatScriptTime((actions.length ? end - zero : 0) / 1000)}
      </Text>
      <LabeledSlider
        label="Visible time"
        value={view.span / 1000}
        display={formatScriptTime(view.span / 1000)}
        min={Math.max(spanStep, MIN_SPAN / 1000)}
        max={Math.ceil(maxSpan / 1000 / spanStep) * spanStep}
        step={spanStep}
        onChange={(s) => setView({ ...view, span: s * 1000 })}
      />
      <Text as="label" size="2">
        <Flex gap="2" align="center">
          <Switch checked={minimap} onCheckedChange={setMinimap} /> Minimap
        </Flex>
      </Text>
      {/* The selected region, its points locked until unlocked. */}
      {region && <>
        <Text size="2" weight="medium">{isInstance(region) ? "Snippet" : "Region"}</Text>
        {isInstance(region) && (
          <TextField.Root
            aria-label="Name"
            value={nameDraft ?? region.snippet.name}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            onBlur={() => {
              const name = nameDraft?.trim();
              if (name && name !== region.snippet.name) renameInstance(region, name);
              setNameDraft(null);
            }}
          >
            <TextField.Slot side="left">Name</TextField.Slot>
          </TextField.Root>
        )}
        <Text size="2" color="gray">{isInstance(region) ? "Snippet" : regionName(region)} · {points(afterTime(actions, region.to) - byTime(actions, region.from))}</Text>
        <Flex gap="2">
          <Button variant="soft" color="gray" style={{ flex: 1 }} disabled={!!placing} title={isInstance(region) ? "Edit its points and regions in the advanced editor (E, or double-click it)" : isRepeat(region) ? "Edit its pattern and setup with Repeat (E, or double-click it)" : "Edit its setup and box with Generate (E, or double-click it)"} onClick={() => editRegion(region)}>
            <Pencil1Icon /> Edit
          </Button>
          <Button variant="soft" color="gray" style={{ flex: 1 }} title="Make its points ordinary points" onClick={() => unlockRegion(region)}>
            <LockOpen1Icon /> Unlock
          </Button>
          <Button variant="soft" color="red" style={{ flex: 1 }} title="Delete it with its points (Delete)" onClick={() => deleteRegion(region)}>
            <TrashIcon /> Delete
          </Button>
        </Flex>
      </>}
      </>}
      {/* In the main script, only a region's Generate. */}
      {(advanced || tool) && <>
        {advanced && !tool && <>
        <Text as="label" size="2">
          <Flex gap="2" align="center">
            <Switch
              checked={fromZero}
              onCheckedChange={(on) => {
                setFromZero(on);
                // Generate's From and To follow, so its box stays.
                if (genBox) setGenRange(rangeFields(genBox, on ? advanced.zero : 0));
              }}
            /> Time from 0
          </Flex>
        </Text>
        <Text as="label" size="2" title="New and dragged points go to the nearest bookmark's time">
          <Flex gap="2" align="center">
            <Switch checked={onMarkers} disabled={!bookmarks.length} onCheckedChange={setOnMarkers} /> Place points on markers
          </Flex>
        </Text>
        <Separator size="4" />
        </>}
        {!tool ? <>
          {/* The tools, on the selected points or all but the regions', each with a small graph of what it does; Generate needs none, Repeat a pattern of two selected. */}
          <Text size="2" weight="medium">Tools</Text>
          {TOOLS.map(({ kind, name, before, after }) => (
            <Button
              key={kind}
              variant="soft"
              color="gray"
              disabled={(kind === "repeat" ? selected.size < 2 : kind !== "generate" && actions.every((a) => regionAt(regions, a.at))) || !!placing}
              title={kind === "repeat" ? "Repeat the selected points, two or more" : undefined}
              onClick={() => openTool(kind)}
              style={{ justifyContent: "flex-start" }}
            >
              <svg width="56" height="24" viewBox="0 0 56 24" fill="none" strokeWidth={1.5} strokeLinejoin="round">
                <polyline points={before} style={{ stroke: "var(--gray-8)" }} />
                <polyline points={after} stroke={LINE_COLOR} />
              </svg>
              {name}
            </Button>
          ))}
        </> : <>
          <Flex gap="2" align="center">
            <IconButton size="1" variant="ghost" color="gray" aria-label="Back to the tools" title="Back to the tools (Escape)" onClick={() => setTool(null)}>
              <ArrowLeftIcon />
            </IconButton>
            <Text size="2" weight="medium">{tool.region ? "Edit region" : TOOLS.find((t) => t.kind === tool.kind)!.name}</Text>
          </Flex>
          {tool.kind === "scale" && ([["time"], ["out", "in"]] as const).map((row) => (
            <Flex key={row[0]} gap="2">
              {row.map((field) => (
                <TextField.Root
                  key={field}
                  type="number"
                  step="any"
                  aria-label={{ time: "Time scale", out: "Out depth", in: "In depth" }[field]}
                  value={scale[field]}
                  onChange={(e) => setScale({ ...scale, [field]: e.target.value })}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <TextField.Slot side="left">{{ time: "Time", out: "Out", in: "In" }[field]}</TextField.Slot>
                  {field === "time" && <TextField.Slot side="right">%</TextField.Slot>}
                </TextField.Root>
              ))}
            </Flex>
          ))}
          {tool.kind === "shift" && ([["offset"], ["out", "in"]] as const).map((row) => (
            <Flex key={row[0]} gap="2">
              {row.map((field) => (
                <TextField.Root
                  key={field}
                  type="number"
                  step="any"
                  aria-label={{ offset: "Depth offset", out: "Out limit", in: "In limit" }[field]}
                  value={shift[field]}
                  onChange={(e) => setShift({ ...shift, [field]: e.target.value })}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <TextField.Slot side="left">{{ offset: "Offset", out: "Out", in: "In" }[field]}</TextField.Slot>
                </TextField.Root>
              ))}
            </Flex>
          ))}
          {/* Speeds without a unit, as depth per second means little to most. */}
          {tool.kind === "speed" && <>
            {/* From 1 to the fastest, mirrored by the field; a typed value past its top leaves it there. Without a segment to slow, only the readout. */}
            {(() => {
              const top = Math.ceil(tool.fastest ?? 0);
              if (top < 1) return <Text size="1" color="gray">Fastest: {tool.fastest === null ? "—" : 0}</Text>;
              const typedLimit = typed(maxSpeed);
              return (
                <Box>
                  <Slider aria-label="Max speed" min={1} max={top} step={1} value={[Number.isFinite(typedLimit) ? clamp(typedLimit, 1, top) : top]} onValueChange={([v]) => setMaxSpeed(String(v))} />
                  <Flex justify="between" mt="1">
                    <Text size="1" color="gray">1</Text>
                    <Text size="1" color="gray">Fastest: {top}</Text>
                  </Flex>
                </Box>
              );
            })()}
            <Flex gap="2" align="center">
              <TextField.Root type="number" min={0} step="any" aria-label="Max speed" value={maxSpeed} onChange={(e) => setMaxSpeed(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
                <TextField.Slot side="left">Max</TextField.Slot>
              </TextField.Root>
              <SegmentedControl.Root size="1" value={speedAnchor} onValueChange={(v) => setSpeedAnchor(v as "in" | "out")} title="Keep the In or the Out reversals">
                <SegmentedControl.Item value="in">In</SegmentedControl.Item>
                <SegmentedControl.Item value="out">Out</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Flex>
          </>}
          {/* The setup's parts as a list, one expanded at a time: Layout the range box's fields, First and the runs on Out and In, Timing the timing and its function, Out and In theirs. */}
          {tool.kind === "generate" && <>
            {partHeader("position", "Layout", genPart !== "position" && `${genRange.from}–${genRange.to} s`)}
            {genPart === "position" && ([["from", "to"], ["out", "in"]] as const).map((row) => (
              <Flex key={row[0]} gap="2">
                {row.map((field) => (
                  <TextField.Root
                    key={field}
                    type="number"
                    step="any"
                    aria-label={{ from: "Range start", to: "Range end", out: "Range out depth", in: "Range in depth" }[field]}
                    value={genRange[field]}
                    onChange={(e) => setGenRange({ ...genRange, [field]: e.target.value })}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    <TextField.Slot side="left">{{ from: "From", to: "To", out: "Out", in: "In" }[field]}</TextField.Slot>
                    {(field === "from" || field === "to") && <TextField.Slot side="right">s</TextField.Slot>}
                  </TextField.Root>
                ))}
              </Flex>
            ))}
            {genPart === "position" && <Flex gap="2" align="center" justify="between">
              <Text size="2">First</Text>
              <SegmentedControl.Root size="1" value={genSetup.first} onValueChange={(v) => setGenSetup({ ...genSetup, first: v as "in" | "out" })} title="Start In or Out">
                <SegmentedControl.Item value="in">In</SegmentedControl.Item>
                <SegmentedControl.Item value="out">Out</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Flex>}
            {genPart === "position" && (
              <Flex gap="2">
                {(["outs", "ins"] as const).map((field) => (
                  <TextField.Root
                    key={field}
                    type="number"
                    min="1"
                    step="1"
                    aria-label={field === "outs" ? "Points in a row on Out" : "Points in a row on In"}
                    value={genSetup[field] ?? "1"}
                    onChange={(e) => setGenSetup({ ...genSetup, [field]: e.target.value })}
                    style={{ flex: 1, minWidth: 0 }}
                  >
                    <TextField.Slot side="left">{field === "outs" ? "Out" : "In"}</TextField.Slot>
                    <TextField.Slot side="right">×</TextField.Slot>
                  </TextField.Root>
                ))}
              </Flex>
            )}
            {partHeader("timing", "Timing", genPart !== "timing" && { interval: "Interval", speed: "Speed", markers: "Markers" }[genSetup.timing])}
            {/* In a row of its own, across the panel. */}
            {genPart === "timing" && (
              <SegmentedControl.Root
                size="1"
                style={{ width: "100%" }}
                value={genSetup.timing}
                // Markers only while the box holds a bookmark.
                onValueChange={(v) => (v !== "markers" || genMarked) && setGenSetup({ ...genSetup, timing: v as GenerateSetup["timing"] })}
                title="Space the points by a time or a speed, or put them at the bookmarks in the box"
              >
                <SegmentedControl.Item value="interval">Interval</SegmentedControl.Item>
                <SegmentedControl.Item value="speed">Speed</SegmentedControl.Item>
                <SegmentedControl.Item
                  value="markers"
                  aria-disabled={!genMarked}
                  title={genMarked ? undefined : "No bookmarks in the box"}
                  style={genMarked ? undefined : { opacity: 0.5, cursor: "not-allowed" }}
                >
                  Markers
                </SegmentedControl.Item>
              </SegmentedControl.Root>
            )}
            {/* Markers timing: which bookmark names it puts points at, all at first; in a popover, as there can be many. */}
            {genPart === "timing" && genSetup.timing === "markers" && (() => {
              const names = [...new Set(bookmarks.map((b) => b.name))].sort((a, b) => a.localeCompare(b));
              const skip = genSetup.skip ?? [];
              const used = names.filter((n) => !skip.includes(n)).length;
              return (
                <Flex gap="2" align="center" justify="between">
                  <Text size="2">Bookmarks</Text>
                  <Popover.Root>
                    <Popover.Trigger>
                      <Button size="1" variant="soft" color="gray" title="The bookmark names to put points at">
                        {used === names.length ? "All names" : `${used} of ${names.length} names`} <ChevronDownIcon />
                      </Button>
                    </Popover.Trigger>
                    {/* Lined up with the button's right edge, which stays put as its label changes width. */}
                    <Popover.Content size="1" align="end" maxWidth="240px" style={{ maxHeight: 320, overflowY: "auto" }}>
                      <Flex direction="column" gap="2">
                        {names.map((n) => (
                          <Text key={n} as="label" size="2">
                            <Flex gap="2" align="center">
                              <Checkbox
                                checked={!skip.includes(n)}
                                onCheckedChange={(on) => {
                                  const next = on ? skip.filter((o) => o !== n) : [...skip, n];
                                  setGenSetup({ ...genSetup, skip: next.length ? next : undefined });
                                }}
                              />
                              <Box flexShrink="0" width="8px" height="8px" style={{ borderRadius: "50%", background: `var(--${markerColor(n)}-9)` }} />
                              <Text truncate>{n}</Text>
                            </Flex>
                          </Text>
                        ))}
                      </Flex>
                    </Popover.Content>
                  </Popover.Root>
                </Flex>
              );
            })()}
            {genPart === "timing" && genSetup.timing !== "markers" && (
              <Text as="label" size="2">
                <Flex gap="2" align="center">
                  <Switch checked={timingView} onCheckedChange={setTimingView} /> Show {genSetup.timing === "speed" ? "Speed" : "Interval"} below the graph
                </Flex>
              </Text>
            )}
            {/* Markers timing has no function. */}
            {funcParts(genSetup.timing === "speed" ? [["speed", "Speed", ""]] : genSetup.timing === "interval" ? [["interval", "Interval", "s"]] : [])}
            <Flex gap="2" align="center" justify="between">
              {/* Of the generated points: their fastest segment and the shortest time between two. */}
              {(() => {
                const made = preview ? [...preview.selected].map((i) => preview.actions[i]) : [];
                const gaps = made.slice(1).map((a, i) => [speed(made[i], a), a.at - made[i].at]);
                return (
                  <Text size="1" color="gray">
                    Fastest: {gaps.length ? Math.ceil(Math.max(...gaps.map(([s]) => s))) : "—"} · Shortest: {gaps.length ? `${Math.min(...gaps.map(([, dt]) => dt))} ms` : "—"}
                  </Text>
                );
              })()}
              <Button size="1" variant="soft" color="gray" onClick={() => setGenSetup(GENERATE_DEFAULTS)}>
                <ResetIcon /> Reset
              </Button>
            </Flex>
          </>}
          {/* Count, then the setup's parts as Generate's: Pattern its box's fields, Time, Out and In their functions. */}
          {tool.kind === "repeat" && <>
            <TextField.Root
              type="number"
              min={1}
              step={1}
              aria-label="Count"
              value={repSetup.count}
              onChange={(e) => setRepSetup({ ...repSetup, count: e.target.value })}
              onKeyDown={(e) => e.key === "-" && e.preventDefault()}
            >
              <TextField.Slot side="left">Count</TextField.Slot>
            </TextField.Root>
            {!repRun && repParams && <Text size="1" color="red">Count must be a whole number, at least 1.</Text>}
            {partHeader("position", "Pattern", genPart !== "position" && `${points(repBox.pattern.length)} · ${repBox.length} s`)}
            {genPart === "position" && <>
              <Text size="1" color="gray">Drag its points in the graph; click in its box to add one, double-click one to remove it. The box's right edge sets its Length.</Text>
              {([["length"], ["out", "in"]] as const).map((row) => (
                <Flex key={row[0]} gap="2">
                  {row.map((field) => (
                    <TextField.Root
                      key={field}
                      type="number"
                      step={field === "length" ? 0.1 : "any"}
                      min={field === "length" ? 0.1 : undefined}
                      aria-label={{ length: "Pattern length", out: "Pattern out depth", in: "Pattern in depth" }[field]}
                      value={repBox[field]}
                      onChange={(e) => setRepBox({ ...repBox, [field]: e.target.value })}
                      style={{ flex: 1, minWidth: 0 }}
                    >
                      <TextField.Slot side="left">{{ length: "Length", out: "Out", in: "In" }[field]}</TextField.Slot>
                      {field === "length" && <TextField.Slot side="right">s</TextField.Slot>}
                    </TextField.Root>
                  ))}
                </Flex>
              ))}
            </>}
            {partHeader("timing", "Time", genPart !== "timing" && SHAPES[repSetup.time.shape].name)}
            {genPart === "timing" && <>
              <Text size="1" color="gray">Each copy's length, in % of the pattern's; a ramp's or spline's from the first copy to the last.</Text>
              <Text as="label" size="2">
                <Flex gap="2" align="center">
                  <Switch checked={timingView} onCheckedChange={setTimingView} /> Show Time below the graph
                </Flex>
              </Text>
            </>}
            {funcParts([["time", "Time", "%"]])}
            <Flex gap="2" align="center" justify="between">
              <Text size="1" color="gray">
                Copies: {repRun ? repRun.starts.length - 1 : "—"} · Ends at: {repRun ? formatScriptTime((repRun.end - zero) / 1000) : "—"}
              </Text>
              <Button size="1" variant="soft" color="gray" onClick={() => setRepSetup(REPEAT_DEFAULTS)}>
                <ResetIcon /> Reset
              </Button>
            </Flex>
          </>}
          {/* At the panel's bottom, docked there while it scrolls, covering what passes under; the padding takes the place of the gap and the panel's own. */}
          <Flex direction="column" gap="2" py="3" mb="-3" style={{ marginTop: "auto", position: "sticky", bottom: 0, background: "var(--color-background)" }}>
            {toolBlocked && <Text size="1" color="red">{toolBlocked}.</Text>}
            <Flex gap="2">
              <Button disabled={!preview || !!toolBlocked} onClick={applyTool} style={{ flex: 1 }}>Apply</Button>
              <Button variant="soft" color="gray" onClick={() => setTool(null)} style={{ flex: 1 }}>Discard</Button>
            </Flex>
          </Flex>
        </>}
      </>}
      {/* At the panel's bottom as a tool's Apply, which takes its place while a tool is open. */}
      {!tool && (
        <Flex direction="column" gap="2" py="3" mb="-3" style={{ marginTop: "auto", position: "sticky", bottom: 0, background: "var(--color-background)" }}>
          {/* The sent stamp makes every send a change, which other tabs hear of. */}
          <Button variant="soft" disabled={actions.length < 2} title="Play these points in the player" onClick={sendToPlayer}>
            <PlayIcon /> Send to player
          </Button>
          {advanced && <>
            {/* At the top level of the library; the editor stays open. */}
            <NamePopover taken={(n) => nameTaken([], n)} onName={(n) => saveSnippet([n], { actions, regions })}>
              <Button variant="soft" disabled={actions.length < 2} title="Save the whole document to the snippet library">
                <ComponentInstanceIcon /> Save as snippet
              </Button>
            </NamePopover>
            <Flex gap="2">
              {doneButton("Done")}
              <Button variant="soft" color="gray" style={{ flex: 1 }} onClick={() => (!advancedChanged() || confirm("Discard the advanced editor's changes?")) && closeAdvanced(false)}>Cancel</Button>
            </Flex>
          </>}
        </Flex>
      )}
    </Flex>
  );

  const mediaProps = {
    ref: (el: HTMLMediaElement | null) => void (videoRef.current = el),
    src: videoUrl ?? undefined,
    controls: true,
    onPlay: () => setPaused(false),
    onPause: () => setPaused(true),
    onEmptied: () => (setPaused(true), setVideoDuration(0)),
    onDurationChange: () => setVideoDuration((videoRef.current?.duration || 0) * 1000),
    onSeeked: seeked,
  };

  // Built only when they change, not on every pointer move while placing.
  const minimapY = (pos: number) => 2 + (1 - pos / 100) * (MINIMAP_HEIGHT - 4);
  const minimapContext = useMemo(() => context.map((run) => `M${run.map((a) => `${minimapX(a.at)},${minimapY(a.pos)}`).join("L")}`).join(""), [context, width, total]);
  const minimapLine = useMemo(() => actions.map((a) => `${minimapX(a.at)},${minimapY(a.pos)}`).join(" "), [actions, width, total]);
  const minimapSelected = useMemo(
    () => kept.map((a, i) => selected.has(i) ? `${selected.has(i - 1) ? "L" : "M"}${minimapX(a.at)},${minimapY(a.pos)}${selected.has(i - 1) ? "" : "l0,0"}` : "").join(""),
    [kept, selected, width, total],
  );

  /** Whether the time from `from` to `to` is in view, to draw only the markers there. */
  const inView = (from: number, to: number) => to >= view.from && from <= view.from + view.span;

  /** Which chapters are drawn light: those touching a dark one before them, so only a run of touching chapters alternates. */
  let lightBefore = false;
  const light = chapters.map((c, i) => (lightBefore = i > 0 && chapters[i - 1].end === c.start && !lightBefore));

  /** The selected point when there is just one, labelled with its time and position. */
  const only = marks.size === 1 ? [...marks][0] : null;

  const content = (
    <Flex direction="column" gap="3" p="3" height="100%">
      {/* Hidden, not unmounted, so the media stays loaded; without media, so it leaves no gap. */}
      <Flex direction="column" gap="3" flexShrink="0" display={videoUrl && playerShown ? undefined : "none"}>
      {videoUrl && isAudio && <audio {...mediaProps} style={{ width: "100%", flexShrink: 0 }} />}
      {videoUrl && !isAudio && (
        <Box position="relative" flexShrink="0">
          <video {...mediaProps} style={{ display: "block", width: "100%", height: videoHeight, background: "black", borderRadius: 6 }} />
          <Box
            title="Drag to resize"
            style={{
              position: "absolute",
              bottom: -10,
              left: "calc(50% - 20px)",
              width: 40,
              height: 12,
              borderBottom: "4px solid var(--gray-a8)",
              cursor: "ns-resize",
              touchAction: "none",
            }}
            onPointerDown={dragVideoHeight}
          />
        </Box>
      )}
      {videoUrl && (
        <Flex align="center" justify="center" gap="2" flexShrink="0">
          {/* The first step nearest the middle. */}
          {[...shownSteps].reverse().map((step, i) => (
            <Button key={`back${i}`} variant="soft" onClick={() => seek(time - step * 1000)}>
              −{step}s
            </Button>
          ))}
          <IconButton variant="soft" aria-label="Previous point" title="Previous point" disabled={!neighbour(-1)} onClick={() => seek(neighbour(-1).at)}>
            <TrackPreviousIcon />
          </IconButton>
          <IconButton
            aria-label={paused ? "Play" : "Pause"}
            onClick={() => (paused ? void videoRef.current?.play() : videoRef.current?.pause())}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
          </IconButton>
          <IconButton variant="soft" aria-label="Next point" title="Next point" disabled={!neighbour(1)} onClick={() => seek(neighbour(1).at)}>
            <TrackNextIcon />
          </IconButton>
          {shownSteps.map((step, i) => (
            <Button key={`fwd${i}`} variant="soft" onClick={() => seek(time + step * 1000)}>
              +{step}s
            </Button>
          ))}
          <IconButton
            variant="soft"
            color="gray"
            aria-label="Playhead to view"
            title="Move the playhead into view"
            disabled={time >= view.from && time <= view.from + view.span}
            onClick={() => seek(view.from + view.span * FOLLOW_AT)}
          >
            <Crosshair2Icon />
          </IconButton>
          {!isAudio && document.pictureInPictureEnabled && (
            <IconButton
              variant={pip ? "solid" : "soft"}
              color="gray"
              aria-label="Picture in picture"
              aria-pressed={pip}
              title="Picture in picture"
              onClick={() => void (pip ? document.exitPictureInPicture() : (videoRef.current as HTMLVideoElement).requestPictureInPicture())}
            >
              <OpenInNewWindowIcon />
            </IconButton>
          )}
          <Popover.Root>
            <Popover.Trigger>
              <IconButton variant="soft" color="gray" aria-label="Step settings">
                <GearIcon />
              </IconButton>
            </Popover.Trigger>
            <Popover.Content width="220px">
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium">Seek steps</Text>
                {steps.map((step, i) => (
                  <TextField.Root
                    key={i}
                    type="number"
                    min={0}
                    step="any"
                    placeholder={i === 0 ? DEFAULT_STEPS[0] : "Off"}
                    aria-label={`Step ${i + 1}`}
                    value={step}
                    onChange={(e) => setSteps(steps.map((s, j) => (j === i ? e.target.value : s)))}
                  >
                    <TextField.Slot side="right">s</TextField.Slot>
                  </TextField.Root>
                ))}
                <Text size="1" color="gray">The first step is always shown; leave the others empty to hide them.</Text>
              </Flex>
            </Popover.Content>
          </Popover.Root>
        </Flex>
      )}
      </Flex>
      {/* Toolbox: convenience buttons for what the keyboard also does. */}
      <Flex gap="2" align="center" flexShrink="0">
        <Flex>
          <IconButton
            variant="soft"
            color="gray"
            disabled={!canUndo}
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            onClick={undo}
            style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
          >
            <ResetIcon />
          </IconButton>
          <Popover.Root modal>
            <Popover.Trigger>
              <IconButton
                variant="soft"
                color="gray"
                disabled={timeline.states.length < 2}
                aria-label="Undo history"
                title="Undo history"
                style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "1px solid var(--gray-a5)" }}
              >
                <CounterClockwiseClockIcon />
              </IconButton>
            </Popover.Trigger>
            <Popover.Content width="240px" style={{ maxHeight: 400, overflowY: "auto" }}>
              <Flex direction="column" gap="1">
                {/* Newest first; undone edits are dimmed until redone or replaced. */}
                {timeline.states.map((state, k) => (
                  <HoverCard.Root key={k} openDelay={100} closeDelay={0}>
                    <HoverCard.Trigger>
                      <Popover.Close>
                        <Button
                          variant={k === timeline.index ? "soft" : "ghost"}
                          color="gray"
                          style={{ justifyContent: "flex-start", opacity: k > timeline.index ? 0.5 : 1 }}
                          onClick={() => jump(k)}
                        >
                          <Text truncate>{state.label}</Text>
                        </Button>
                      </Popover.Close>
                    </HoverCard.Trigger>
                    <HoverCard.Content side="right" size="1" maxWidth="232px">
                      <Flex direction="column" gap="1">
                        <Text size="1">{state.label}</Text>
                        {k > 0 && (() => {
                          const before = timeline.states[k - 1];
                          const markersChanged = before.chapters !== state.chapters || before.bookmarks !== state.bookmarks;
                          // A change only to the regions has no points to show.
                          if (before.actions === state.actions && !markersChanged && before.regions !== state.regions) return <Text size="1" color="gray">Regions changed</Text>;
                          return <>
                            {(before.actions !== state.actions || !markersChanged) && <PreviewGraph pieces={diffPieces(before.actions, state.actions)} />}
                            {markersChanged && <MarkerPreview before={before} after={state} />}
                          </>;
                        })()}
                      </Flex>
                    </HoverCard.Content>
                  </HoverCard.Root>
                )).reverse()}
                <Text size="1" color="gray" mt="1">Click an entry to go back or forward to it.</Text>
              </Flex>
            </Popover.Content>
          </Popover.Root>
        </Flex>
        <IconButton variant="soft" color="gray" disabled={!canRedo} aria-label="Redo" title="Redo (Ctrl+Shift+Z)" onClick={redo}>
          <ResetIcon style={{ transform: "scaleX(-1)" }} />
        </IconButton>
        <Separator orientation="vertical" size="2" />
        <IconButton variant="soft" color="gray" disabled={!copyable} aria-label="Copy" title="Copy (Ctrl+C)" onClick={() => void copyButton(false)}>
          <CopyIcon />
        </IconButton>
        <IconButton variant="soft" color="gray" disabled={!copyable || !!tool} aria-label="Cut" title="Cut (Ctrl+X)" onClick={() => void copyButton(true)}>
          <ScissorsIcon />
        </IconButton>
        {/* With a history, its button docks to the paste button. */}
        <Flex>
          <IconButton
            variant="soft"
            color="gray"
            disabled={!!tool}
            aria-label="Paste"
            title="Paste (Ctrl+V)"
            onClick={() => void pasteButton()}
            style={history.length ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : undefined}
          >
            <ClipboardIcon />
          </IconButton>
          {history.length > 0 && <Popover.Root modal>
            <Popover.Trigger>
              <IconButton
                variant="soft"
                color="gray"
                disabled={!!tool}
                aria-label="Clipboard history"
                title="Clipboard history"
                style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "1px solid var(--gray-a5)" }}
              >
                <CounterClockwiseClockIcon />
              </IconButton>
            </Popover.Trigger>
            <Popover.Content width="220px">
              <Flex direction="column" gap="1">
                {history.map((copied, i) => (
                  <HoverCard.Root key={i} openDelay={100} closeDelay={0}>
                    <HoverCard.Trigger>
                      <Popover.Close>
                        <Button variant="ghost" color="gray" style={{ justifyContent: "flex-start" }} onClick={() => pasteFromHistory(copied)}>
                          {points(copied.actions.length)}{copied.regions.length > 0 && ` · ${copied.regions.length === 1 ? "region" : `${copied.regions.length} regions`}`} · {formatScriptTime(copied.actions[copied.actions.length - 1].at / 1000)}
                        </Button>
                      </Popover.Close>
                    </HoverCard.Trigger>
                    <HoverCard.Content side="right" size="1">
                      <PreviewGraph pieces={[{ kind: "plain", points: copied.actions }]} />
                    </HoverCard.Content>
                  </HoverCard.Root>
                ))}
                <Text size="1" color="gray" mt="1">Click an entry to paste it and make it the clipboard again.</Text>
              </Flex>
            </Popover.Content>
          </Popover.Root>}
        </Flex>
        <Separator orientation="vertical" size="2" />
        <Button
          variant={boxMode ? "solid" : "soft"}
          color={boxMode ? undefined : "gray"}
          aria-pressed={boxMode}
          disabled={!!tool}
          title="Select points with a box (S)"
          onClick={toggleBoxMode}
        >
          {/* A dashed selection box, sized like the icons. */}
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <rect x="2" y="2" width="11" height="11" rx="1" stroke="currentColor" strokeDasharray="2 2" />
          </svg>
          Select
        </Button>
        {boxMode && (
          <Button
            variant={selectByTime ? "solid" : "soft"}
            color={selectByTime ? undefined : "gray"}
            aria-pressed={selectByTime}
            title="Select by time, at any depth"
            onClick={() => {
              setSelectByTime(!selectByTime);
              if (!selectByTime && box) selectIn({ ...box, low: 0, high: 100 });
            }}
          >
            <HeightIcon /> By time
          </Button>
        )}
        <Separator orientation="vertical" size="2" />
        <Button
          variant={lifted ? "solid" : "soft"}
          color={lifted ? undefined : "gray"}
          aria-pressed={!!lifted}
          disabled={(!lifted && !selected.size) || !!tool}
          title="Move the selected points by dragging them; again places them (M)"
          onClick={toggleMove}
        >
          <MoveIcon /> Move
        </Button>
        {placing && (
          <Button
            variant={inserting ? "solid" : "soft"}
            color={inserting ? undefined : "gray"}
            aria-pressed={inserting}
            title="Insert: move later points right instead of replacing them (hold Shift to switch)"
            onClick={() => setInsertMode(!insertMode)}
          >
            <ColumnSpacingIcon /> Insert
          </Button>
        )}
        {/* Nothing lifted, there is no gap. */}
        {!!lifted?.size && (
          <Button
            variant={closeGap ? "solid" : "soft"}
            color={closeGap ? undefined : "gray"}
            aria-pressed={closeGap}
            title="Close the gap: take out the time the moved points spanned, moving later points left"
            onClick={() => setCloseGap(!closeGap)}
          >
            <PinLeftIcon /> Close gap
          </Button>
        )}
        <Separator orientation="vertical" size="2" />
        <Button
          variant={advanced ? "solid" : "soft"}
          color={advanced ? undefined : "gray"}
          aria-pressed={!!advanced}
          disabled={!!placing || !!tool}
          title={advanced ? "Back to the script, asking to apply or discard any changes" : "Edit the selected points, or new ones, in the advanced editor (E)"}
          onClick={() => (!advanced ? openAdvanced() : advancedChanged() ? setLeaving(true) : closeAdvanced(false))}
        >
          <MixerHorizontalIcon /> Advanced
        </Button>
        <AlertDialog.Root open={leaving} onOpenChange={setLeaving}>
          <AlertDialog.Content maxWidth="400px">
            <AlertDialog.Title>Leave the advanced editor</AlertDialog.Title>
            <AlertDialog.Description size="2">Apply the changes or discard them?</AlertDialog.Description>
            <Flex gap="3" mt="4">
              {doneButton("Apply")}
              <Button variant="soft" color="red" style={{ flex: 1 }} onClick={() => closeAdvanced(false)}>Discard</Button>
              <AlertDialog.Cancel>
                <Button variant="soft" color="gray" style={{ flex: 1 }}>Keep editing</Button>
              </AlertDialog.Cancel>
            </Flex>
          </AlertDialog.Content>
        </AlertDialog.Root>
        {videoUrl && <>
          <Separator orientation="vertical" size="2" />
          <Button
            variant={playerShown ? "solid" : "soft"}
            color={playerShown ? undefined : "gray"}
            aria-pressed={playerShown}
            title={`${playerShown ? "Hide" : "Show"} the ${isAudio ? "audio" : "video"} player (P)`}
            onClick={togglePlayer}
          >
            <VideoIcon /> Player
          </Button>
        </>}
        <IconButton
          variant={asideShown ? "solid" : "soft"}
          color={asideShown ? undefined : "gray"}
          aria-pressed={asideShown}
          aria-label="Markers and snippets"
          title={`${asideShown ? "Hide" : "Show"} the markers and snippets`}
          onClick={() => setAsideShown(!asideShown)}
          style={{ marginLeft: "auto" }}
        >
          <ViewVerticalIcon />
        </IconButton>
      </Flex>
      {/* The graph with the marker lane under it; the wheel works on both. */}
      <Flex
        ref={timeRef}
        direction="column"
        gap="3"
        flexGrow="1"
        // Its own least height, so it shrinks with the graph instead of keeping the graph's measured one.
        minHeight={`${120 + 12 + LANE_HEIGHT + (timingShown ? timingHeight + 12 : 0)}px`}
        onPointerMove={(e) => void (hoverAt.current = Math.max(pointerAt(e).at, 0))}
        onPointerLeave={() => void (hoverAt.current = null)}
      >
        <Box ref={boxRef} position="relative" flexGrow="1" minHeight="120px" style={{ borderRadius: 6, background: "var(--gray-a2)", overflow: "hidden" }}>
          <svg
            width={width}
            height={height}
            onPointerDown={add}
            // Double-clicking a region edits it.
            onDoubleClick={(e) => {
              const r = !tool && !boxMode && regionAt(regions, pointerAt(e).at);
              if (r) editRegion(r);
            }}
            onPointerMove={(e) => {
              // Points are drawn on the canvas, so the cursor shows when one can be grabbed; placing, a click places instead.
              if (!placing) {
                e.currentTarget.style.cursor = tool ? "default" : pointUnder(e) !== null || regionAt(regions, pointerAt(e).at) ? "grab" : "crosshair";
                return;
              }
              // Pasted points follow the pointer; moved ones stay where their box is dragged.
              if (!lifted) setPlaceAt(pointerAt(e));
              setHeld({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
            }}
            onPointerLeave={() => !lifted && setPlaceAt(null)}
            // A snippet's row dragged here goes in where it is released, unless refused there.
            onPointerUp={(e) => {
              if (!rowDrag || !placing) return;
              const [pasted, insert] = pastedAt(e);
              if (!refuses(pasted, insert)) put(pasted, insert);
            }}
            style={{ display: "block", cursor: "crosshair", touchAction: "none", userSelect: "none" }}
          >
            {/* The chapters shaded behind the plot, as in the minimap. */}
            {chapters.map((c, i) => inView(c.start, c.end) && (
              <rect key={i} x={x(c.start)} width={x(c.end) - x(c.start)} height={plotHeight} style={{ fill: light[i] ? "var(--gray-a3)" : "var(--gray-a4)" }} />
            ))}
            {/* In the advanced editor, the main script's regions faintly, read-only. */}
            {advanced && main.regions.map((r, i) => i !== advanced.instance && inView(r.from, r.to) && (
              <rect key={`m${i}`} x={x(r.from)} width={x(r.to) - x(r.from)} height={plotHeight} strokeDasharray="4 2" style={{ ...bandOf(r), opacity: 0.5 }} />
            ))}
            {astray && (
              <rect x={x(astray.regions[0].from)} width={x(astray.regions[0].to) - x(astray.regions[0].from)} height={plotHeight} style={{ fill: "var(--red-a3)", stroke: "var(--red-9)" }} />
            )}
            {/* The regions' bands over them, with those being placed, a selected one outlined as the selected markers; their labels are in the box. */}
            {[...shownRegions, ...ghostRegions].map((r, i) => inView(r.from, r.to) && (
              <rect
                key={`r${i}`}
                x={x(r.from)}
                width={x(r.to) - x(r.from)}
                height={plotHeight}
                strokeWidth={r === region ? 2 : 1}
                style={{ fill: bandOf(r).fill, stroke: r === region ? "var(--accent-9)" : bandOf(r).stroke }}
              />
            ))}
            {[0, 50, 100].map((pos) => (
              <line key={pos} x1={0} x2={width} y1={y(pos)} y2={y(pos)} style={{ stroke: "var(--gray-a5)" }} />
            ))}
            {/* Round in the time shown. */}
            {timeTicks((view.from - zero) / 1000, (view.from + view.span - zero) / 1000).map((t) => (
              <g key={t}>
                <line x1={x(t * 1000 + zero)} x2={x(t * 1000 + zero)} y1={0} y2={plotHeight} style={{ stroke: "var(--gray-a4)" }} />
                <text x={x(t * 1000 + zero)} y={height - 6} textAnchor="middle" fontSize={11} style={{ fill: "var(--gray-11)" }}>
                  {formatTimeTick(t)}
                </text>
              </g>
            ))}
            {/* Faint lines from the bookmarks in the lane up through the graph. */}
            {bookmarks.filter((b) => inView(b.time, b.time)).map((b, i) => (
              <line key={`b${i}`} x1={x(b.time)} x2={x(b.time)} y1={0} y2={height} style={{ stroke: `var(--${markerColor(b.name)}-a6)` }} />
            ))}
            {videoUrl && (
              <g onPointerDown={dragPlayhead} style={{ cursor: "ew-resize" }}>
                {/* A wider, invisible line to grab. */}
                <line x1={x(time)} x2={x(time)} y1={0} y2={plotHeight} strokeWidth={12} stroke="transparent" />
                <line x1={x(time)} x2={x(time)} y1={0} y2={plotHeight} strokeWidth={2} style={{ stroke: "var(--gray-12)" }} />
                <path d={`M${x(time) - 6},0 h12 l-6,8 z`} style={{ fill: "var(--gray-12)" }} />
              </g>
            )}
            {/* The time the pasted points cover: replacing, its points go and show red; inserting, the later points move past it. */}
            {ghostSpan && (
              <rect
                x={x(ghostSpan[0])}
                width={Math.max(x(ghostSpan[1]) - x(ghostSpan[0]), 1)}
                y={0}
                height={plotHeight}
                style={{ fill: inserting && !refused ? "var(--green-a3)" : "var(--red-a3)", pointerEvents: "none" }}
              />
            )}
            {/* Kept in the SVG, so the line and points stay between what is drawn under and over them. */}
            <foreignObject width={width} height={height} style={{ pointerEvents: "none" }}>
              <canvas ref={canvasRef} style={{ display: "block", width, height }} />
            </foreignObject>
            {/* The copied points' original lowest and highest depth, what Ctrl keeps them at. */}
            {ghost && placing && [Math.min(...placing.actions.map((a) => a.pos)), Math.max(...placing.actions.map((a) => a.pos))].map((pos, i) => (
              <line key={i} x1={0} x2={width} y1={y(pos)} y2={y(pos)} strokeDasharray="6 4" style={{ stroke: LINE_COLOR, opacity: 0.6, pointerEvents: "none" }} />
            ))}
            {/* While placing, a click anywhere places, over points and the playhead alike; moving, outside the time they cover. */}
            {placing && (
              // No menu for Ctrl+click, which is a right-click on a Mac.
              <rect width={width} height={height} fill="transparent" style={{ cursor: refused ? "not-allowed" : lifted ? "default" : "copy" }} onPointerDown={place} onContextMenu={(e) => e.preventDefault()} />
            )}
            {/* Moving, the time the points cover is dragged; at least a grip wide, for a single point. */}
            {lifted && ghost && (() => {
              const [from, to] = [x(ghost[0].at), x(ghost[ghost.length - 1].at)];
              const w = Math.max(to - from, 2 * GRIP);
              return <rect x={(from + to - w) / 2} width={w} height={plotHeight} fill="transparent" style={{ cursor: "move" }} onPointerDown={dragLifted} />;
            })()}
            {edges && (
              <g>
                <rect
                  x={edges.from}
                  y={edges.high}
                  width={edges.to - edges.from}
                  height={edges.low - edges.high}
                  strokeDasharray="4 2"
                  style={{ ...TOOL_BOX, cursor: "move", pointerEvents: boxMode && !placing ? undefined : "none" }}
                  onPointerDown={(e) => editBox(e, ["from", "to", "low", "high"])}
                />
                {/* Selecting by time, only the edges in time can be dragged. */}
                {boxMode && !placing && GRIPS.filter(([, v]) => !selectByTime || !v).map(([h, v]) => (
                  <rect
                    key={`${h}-${v}`}
                    x={h ? edges[h] - GRIP / 2 : edges.from}
                    width={h ? GRIP : edges.to - edges.from}
                    y={v ? edges[v] - GRIP / 2 : edges.high}
                    height={v ? GRIP : edges.low - edges.high}
                    style={h && v
                      ? { fill: "var(--color-panel-solid)", stroke: "var(--accent-9)", cursor: (h === "from") === (v === "high") ? "nwse-resize" : "nesw-resize" }
                      : { fill: "transparent", cursor: h ? "ew-resize" : "ns-resize" }}
                    onPointerDown={(e) => editBox(e, [h, v].filter((s) => s !== null))}
                  />
                ))}
              </g>
            )}
            {/* Scale's box, like the selection box: its right edge stretches time, its top and bottom set the depths, the right corners both, its body moves the depths together; all at one time, it only has the depths. */}
            {scaleBox && (() => {
              const [left, right] = [x(scaleBox.t0), x(scaleBox.to)];
              const [top, bottom] = [y(Math.max(scaleBox.low, scaleBox.high)), y(Math.min(scaleBox.low, scaleBox.high))];
              const stretches = scaleBox.t1 > scaleBox.t0;
              const w = Math.max(right - left, 2 * GRIP);
              return (
                <g>
                  <rect x={left} y={top} width={right - left} height={bottom - top} strokeDasharray="4 2" style={{ ...TOOL_BOX, cursor: "ns-resize" }} onPointerDown={(e) => dragScale(e, ["low", "high"])} />
                  {(["low", "high"] as const).map((v) => grip(v, [(left + right - w) / 2, y(scaleBox[v]) - GRIP / 2, w, GRIP], "ns-resize", (e) => dragScale(e, [v])))}
                  {stretches && grip("to", [right - GRIP / 2, top, GRIP, bottom - top], "ew-resize", (e) => dragScale(e, ["to"]))}
                  {stretches && (["low", "high"] as const).map((v) => (
                    grip(`to-${v}`, [right - GRIP / 2, y(scaleBox[v]) - GRIP / 2, GRIP, GRIP], y(scaleBox[v]) === top ? "nesw-resize" : "nwse-resize", (e) => dragScale(e, ["to", v]), true)
                  ))}
                </g>
              );
            })()}
            {/* Shift depth's box, where the points go before Out and In clamp them, past 0 or 100 too; its body drags up and down. Out and In as dashed lines over it, with grips. */}
            {shiftBox && toolSpan && (() => {
              // At least a grip wide and high, for a single point or flat ones.
              const w = Math.max(x(toolSpan.t1) - x(toolSpan.t0), 2 * GRIP);
              const left = (x(toolSpan.t0) + x(toolSpan.t1) - w) / 2;
              const [top, bottom] = [y(toolSpan.hi + shiftBox.offset), y(toolSpan.lo + shiftBox.offset)];
              const h = Math.max(bottom - top, GRIP);
              return (
                <g>
                  <rect x={left} y={(top + bottom - h) / 2} width={w} height={h} strokeDasharray="4 2" style={{ ...TOOL_BOX, cursor: "ns-resize" }} onPointerDown={(e) => dragShift(e, "offset")} />
                  {(["min", "max"] as const).map((v) => (
                    <g key={v}>
                      <line x1={left} x2={left + w} y1={y(shiftBox[v])} y2={y(shiftBox[v])} strokeDasharray="6 4" strokeWidth={1.5} style={{ stroke: "var(--accent-9)", pointerEvents: "none" }} />
                      {grip(`${v}-line`, [left, y(shiftBox[v]) - GRIP / 2, w, GRIP], "ns-resize", (e) => dragShift(e, v))}
                      {grip(`${v}-grip`, [left + w - GRIP / 2, y(shiftBox[v]) - GRIP / 2, GRIP, GRIP], "ns-resize", (e) => dragShift(e, v), true)}
                    </g>
                  ))}
                </g>
              );
            })()}
            {/* Generate's range box, like the selection box: with Layout shown its edges and corners resize it, its body moves it. Out's and In's curves dashed in it, the shown one's bolder, with its handles. */}
            {genBox && (() => {
              const b = { from: x(genBox.from), to: x(genBox.to), low: y(genBox.low), high: y(genBox.high) };
              const depth = (v: number) => y(genBox.high - (v * (genBox.high - genBox.low)) / 100);
              const position = genPart === "position";
              return (
                <g>
                  <rect x={b.from} y={b.high} width={b.to - b.from} height={b.low - b.high} strokeDasharray="4 2" style={{ ...TOOL_BOX, cursor: "move", pointerEvents: position ? undefined : "none" }} onPointerDown={(e) => dragGenerate(e, ["from", "to", "low", "high"])} />
                  {(["out", "in"] as const).map((key) => (
                    <polyline key={key} points={genCurve(key, (v) => depth(clamp(v, 0, 100)))} fill="none" strokeWidth={genPart === key ? 2 : 1} strokeDasharray="4 3" style={{ stroke: "var(--accent-9)", pointerEvents: "none" }} />
                  ))}
                  {position && GRIPS.map(([h, v]) => grip(
                    `${h}-${v}`,
                    [h ? b[h] - GRIP / 2 : b.from, v ? b[v] - GRIP / 2 : b.high, h ? GRIP : b.to - b.from, v ? GRIP : b.low - b.high],
                    h && v ? ((h === "from") === (v === "high") ? "nwse-resize" : "nesw-resize") : h ? "ew-resize" : "ns-resize",
                    (e) => dragGenerate(e, [h, v].filter((s) => s !== null)),
                    !!(h && v),
                  ))}
                  {(genPart === "out" || genPart === "in") && funcHandles(genPart, depth)}
                </g>
              );
            })()}
            {/*
              Repeat: the copies' time shaded over the pattern box's depths, Out's and In's curves dashed across it, the shown one's bolder, with its handles.
              The pattern box, a click in its time adding a point, its right edge setting Length, its top and bottom its depths; its points over it, joined by a solid line, dragged.
            */}
            {tool?.kind === "repeat" && repParams && (() => {
              const [left, right, top, bottom] = [x(repBox.from), x(repBox.from + repParams.length), y(repParams.top), y(repParams.bottom)];
              const depth = (v: number) => y(repParams.top - (v * (repParams.top - repParams.bottom)) / 100);
              return (
                <g>
                  {fnBox && <rect x={left} y={top} width={x(fnBox.to) - left} height={bottom - top} style={{ fill: TOOL_BOX.fill, pointerEvents: "none" }} />}
                  {fnBox && (["out", "in"] as const).map((key) => (
                    <polyline key={key} points={genCurve(key, (v) => depth(clamp(v, 0, 100)))} fill="none" strokeWidth={genPart === key ? 2 : 1} strokeDasharray="4 3" style={{ stroke: "var(--accent-9)", pointerEvents: "none" }} />
                  ))}
                  <rect x={left} width={right - left} height={plotHeight} fill="transparent" style={{ cursor: "copy" }} onPointerDown={addPattern} />
                  <rect x={left} y={top} width={right - left} height={bottom - top} strokeDasharray="4 2" style={{ fill: "none", stroke: TOOL_BOX.stroke, pointerEvents: "none" }} />
                  {(["low", "high"] as const).map((v) => grip(v, [left, y(repParams[v === "low" ? "bottom" : "top"]) - GRIP / 2, right - left, GRIP], "ns-resize", (e) => dragRepeat(e, [v])))}
                  {grip("to", [right - GRIP / 2, top, GRIP, Math.max(bottom - top, GRIP)], "ew-resize", (e) => dragRepeat(e, ["to"]))}
                  {(["low", "high"] as const).map((v) => grip(`to-${v}`, [right - GRIP / 2, (v === "low" ? bottom : top) - GRIP / 2, GRIP, GRIP], v === "high" ? "nesw-resize" : "nwse-resize", (e) => dragRepeat(e, ["to", v]), true))}
                  <polyline points={repBox.pattern.filter((a) => a.at <= repBox.from + repParams.length).map((a) => `${x(a.at)},${y(a.pos)}`).join(" ")} fill="none" strokeWidth={2} strokeLinejoin="round" style={{ stroke: "var(--gray-12)", pointerEvents: "none" }} />
                  {repBox.pattern.map((a, i) => a.at <= repBox.from + repParams.length && (
                    <circle key={i} cx={x(a.at)} cy={y(a.pos)} r={5} style={{ fill: LINE_COLOR, stroke: "var(--gray-12)", cursor: "move" }} onPointerDown={(e) => dragPattern(e, i)} />
                  ))}
                  {fnBox && (genPart === "out" || genPart === "in") && funcHandles(genPart, depth)}
                </g>
              );
            })()}
            {only !== null && shown[only] && (
              <text
                x={x(shown[only].at)}
                y={y(shown[only].pos) + (shown[only].pos > 80 ? 22 : -12)}
                textAnchor="middle"
                fontSize={12}
                style={{ fill: "var(--gray-12)" }}
              >
                {formatScriptTime((shown[only].at - zero) / 1000, 2)} · {Math.round(100 - shown[only].pos)}
              </text>
            )}
          </svg>
          {extenders.map(([label, Icon, sides, , left, top]) => (
            <IconButton
              key={label}
              size="1"
              variant="surface"
              aria-label={label}
              title={label}
              style={{ position: "absolute", left, top }}
              onClick={() => selectIn({ ...box!, ...sides })}
            >
              <Icon />
            </IconButton>
          ))}
          {/* Each region's label in its band's top corner, kept in view and cut off where there is no room. */}
          {[...shownRegions, ...ghostRegions].map((r, i) => inView(r.from, r.to) && (
            <Text
              key={i}
              size="1"
              truncate
              style={{ position: "absolute", top: 2, left: Math.max(x(r.from), 0), maxWidth: Math.min(x(r.to), width) - Math.max(x(r.from), 0), boxSizing: "border-box", padding: "0 4px", color: bandOf(r).label, pointerEvents: "none" }}
            >
              {regionName(r)}
            </Text>
          ))}
          {/* As in the player: 100 (top) is the shallow end, out towards home. */}
          <Text size="1" color="gray" style={{ position: "absolute", top: 4, right: 8, pointerEvents: "none" }}>Out</Text>
          <Text size="1" color="gray" style={{ position: "absolute", bottom: AXIS + 4, right: 8, pointerEvents: "none" }}>In</Text>
        </Box>
        {/* The timing function, Generate's Interval or Speed or Repeat's Time, in the graph's time, over the box's, on a scale of its own from 0 at the bottom; with Timing shown, its handles as Out's and In's in the box. */}
        {timingShown && (() => {
          const key = timingKey!;
          return (
            <Box position="relative" flexShrink="0" height={`${timingHeight}px`} style={{ borderRadius: 6, background: "var(--gray-a2)", overflow: "hidden" }}>
              <svg width={width} height={timingHeight} style={{ display: "block", touchAction: "none", userSelect: "none" }}>
                <rect x={x(fnBox.from)} width={x(fnBox.to) - x(fnBox.from)} height={timingHeight} style={{ fill: TOOL_BOX.fill, pointerEvents: "none" }} />
                {timingLow < timingHigh && <>
                  {[0, 0.5, 1].map((f) => (
                    <g key={f} style={{ pointerEvents: "none" }}>
                      <line x1={0} x2={width} y1={PAD + (1 - f) * (timingHeight - 2 * PAD)} y2={PAD + (1 - f) * (timingHeight - 2 * PAD)} style={{ stroke: "var(--gray-a5)" }} />
                      <text x={width - 4} y={PAD + (1 - f) * (timingHeight - 2 * PAD) + (f === 0 ? -3 : f === 1 ? 10 : 3)} textAnchor="end" fontSize={10} style={{ fill: "var(--blue-11)" }}>
                        {/* Interval's in s, as its fields, Time's in %. */}
                        {key === "interval" ? +((timingLow + f * (timingHigh - timingLow)) / 1000).toFixed(2) : `${Math.round(timingLow + f * (timingHigh - timingLow))}${key === "time" ? "%" : ""}`}
                      </text>
                    </g>
                  ))}
                  <polyline points={genCurve(key, timingY)} fill="none" strokeWidth={1.5} style={{ stroke: "var(--blue-9)", pointerEvents: "none" }} />
                  {genPart === "timing" && funcHandles(key, timingY)}
                </>}
              </svg>
              {genPart === "timing" && (
                <Box
                  title="Drag to resize"
                  style={{
                    position: "absolute",
                    top: 0,
                    left: "calc(50% - 20px)",
                    width: 40,
                    height: 8,
                    borderTop: "4px solid var(--gray-a8)",
                    cursor: "ns-resize",
                    touchAction: "none",
                  }}
                  onPointerDown={(e) => dragHeight(e, timingTall, setTimingTall, TIMING_HEIGHT, true)}
                />
              )}
            </Box>
          );
        })()}
        {/* The marker lane, in the graph's time: chapters as bands, touching ones in alternating shades, bookmarks as flags over them; names cut off where there is no room. */}
        {/* A press on a marker selects it; on empty lane, a click adds a bookmark and a drag draws a chapter. */}
        <Box
          position="relative"
          flexShrink="0"
          height={`${LANE_HEIGHT}px`}
          onPointerDown={laneDown}
          onPointerEnter={() => void (overLane.current = true)}
          onPointerLeave={() => void (overLane.current = false)}
          // The advanced editor's document has no markers, so the lane takes no presses while it is open.
          style={{ borderRadius: 6, background: "var(--gray-a2)", overflow: "hidden", userSelect: "none", touchAction: "none", cursor: "crosshair", pointerEvents: advanced ? "none" : undefined }}
        >
          {chapters.map((c, i) => {
            if (!inView(c.start, c.end)) return null;
            // Kept in view, so the name of a chapter that starts before it still shows; it ends at the first flag on it, which goes over it.
            const left = Math.max(x(c.start), 0);
            const flag = bookmarks.find((b) => x(b.time) >= left && b.time < c.end);
            return (
              <Box
                key={i}
                position="absolute"
                height="100%"
                onPointerDown={(e) => markerDown(e, c)}
                style={{ left, width: Math.min(x(c.end), width) - left, background: light[i] ? "var(--gray-a3)" : "var(--gray-a5)", cursor: "grab", ...(marked.has(c) && SELECTED_MARKER) }}
              >
                <Text as="div" size="1" truncate style={{ maxWidth: flag && x(flag.time) - left, boxSizing: "border-box", lineHeight: `${LANE_HEIGHT}px`, padding: "0 4px" }}>
                  {c.name}
                </Text>
                {/* Grips on its edges in view resize it. */}
                {(["start", "end"] as const).filter((side) => x(c[side]) >= 0 && x(c[side]) <= width).map((side) => (
                  <Box
                    key={side}
                    position="absolute"
                    top="0"
                    height="100%"
                    onPointerDown={(e) => markerDown(e, c, [side])}
                    style={{ [side === "start" ? "left" : "right"]: 0, width: MARKER_GRIP, cursor: "ew-resize" }}
                  />
                ))}
              </Box>
            );
          })}
          {/* Each flag's name runs up to the next one; they are sorted by time. */}
          {bookmarks.map((b, i) => inView(b.time, b.time) && (
            <Text
              key={i}
              as="div"
              size="1"
              truncate
              onPointerDown={(e) => markerDown(e, b)}
              style={{
                position: "absolute",
                // Its 2px edge centred on its time, like its line through the graph.
                left: x(b.time) - 1,
                maxWidth: bookmarks[i + 1] && x(bookmarks[i + 1].time) - x(b.time),
                boxSizing: "border-box",
                height: "100%",
                lineHeight: `${LANE_HEIGHT}px`,
                padding: "0 4px",
                borderLeft: `2px solid var(--${markerColor(b.name)}-9)`,
                // Opaque, so it hides what it covers.
                background: `linear-gradient(var(--${markerColor(b.name)}-a4), var(--${markerColor(b.name)}-a4)), var(--color-panel-solid)`,
                cursor: "grab",
                ...(marked.has(b) && SELECTED_MARKER),
              }}
            >
              {b.name}
            </Text>
          ))}
          {/* Accepted with Enter or by clicking away; Escape keeps the old name. Suggests the names in the script. */}
          {naming && (
            <Popover.Root open modal onOpenChange={(open) => !open && closeNaming(true)}>
              <Popover.Anchor style={{ position: "absolute", left: Math.max(x(naming.from), 0), width: Math.min(x(naming.to), width) - Math.max(x(naming.from), 0), height: "100%", pointerEvents: "none" }} />
              <Popover.Content
                size="1"
                width="200px"
                // In a portal, but React still bubbles its presses up to the lane, which would add a marker.
                onPointerDown={(e) => e.stopPropagation()}
                onEscapeKeyDown={(e) => {
                  e.preventDefault();
                  closeNaming(false);
                }}
              >
                <Flex gap="2">
                  <TextField.Root
                    size="1"
                    aria-label="Name"
                    list="marker-names"
                    value={naming.name}
                    onFocus={(e) => e.target.select()}
                    onChange={(e) => setNaming({ ...naming, name: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && closeNaming(true)}
                    style={{ flexGrow: 1 }}
                  />
                  {naming.remove && (
                    <Button
                      size="1"
                      variant="soft"
                      color="red"
                      onClick={() => {
                        naming.remove!();
                        setNaming(null);
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </Flex>
                <datalist id="marker-names">
                  {[...new Set([...chapters, ...bookmarks].map((m) => m.name))].map((name) => <option key={name} value={name} />)}
                </datalist>
              </Popover.Content>
            </Popover.Root>
          )}
        </Box>
      </Flex>
      {minimap ? (
        <svg
          width={width}
          height={MINIMAP_HEIGHT}
          aria-label="Minimap"
          onPointerDown={dragMinimap}
          style={{ display: "block", flexShrink: 0, borderRadius: 6, background: "var(--gray-a2)", touchAction: "none", userSelect: "none" }}
        >
          {chapters.map((c, i) => (
            <rect key={i} x={minimapX(c.start)} width={minimapX(c.end) - minimapX(c.start)} height={MINIMAP_HEIGHT} style={{ fill: light[i] ? "var(--gray-a3)" : "var(--gray-a4)" }} />
          ))}
          {[...(advanced ? main.regions : []), ...regions].map((r, i) => (
            <rect key={`r${i}`} x={minimapX(r.from)} width={minimapX(r.to) - minimapX(r.from)} height={MINIMAP_HEIGHT} style={{ fill: bandOf(r).fill }} />
          ))}
          {/* The main script's other points behind the advanced editor's. */}
          {advanced && <path d={minimapContext} fill="none" strokeWidth={1} style={{ stroke: "var(--gray-a7)", pointerEvents: "none" }} />}
          {/* ponytail: the whole script as one polyline; fine for thousands of points, thin it out if a long script lags. */}
          <polyline
            points={minimapLine}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={1}
          />
          {/* The selected runs over it, a lone selected point as a dot. */}
          <path
            d={minimapSelected}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ stroke: "var(--gray-12)", pointerEvents: "none" }}
          />
          {bookmarks.map((b, i) => (
            <line key={i} x1={minimapX(b.time)} x2={minimapX(b.time)} y1={0} y2={6} strokeWidth={2} style={{ stroke: `var(--${markerColor(b.name)}-9)` }} />
          ))}
          {videoUrl && <line x1={minimapX(time)} x2={minimapX(time)} y1={0} y2={MINIMAP_HEIGHT} style={{ stroke: "var(--gray-12)" }} />}
          <rect
            x={minimapX(view.from)}
            width={Math.max(minimapX(view.span), 4)}
            height={MINIMAP_HEIGHT}
            rx={4}
            style={{ fill: "var(--gray-a5)", stroke: "var(--gray-a8)", cursor: "grab" }}
          />
        </svg>
      ) : (
        <Slider
          aria-label="Scroll through time"
          min={0}
          max={Math.max(end, view.span)}
          step={10}
          value={[view.from]}
          onValueChange={([from]) => setView({ ...view, from })}
        />
      )}
    </Flex>
  );

  /** Beside the graph: the markers or the snippets, switched at its top as the player's modes. */
  const asidePanel = <Flex direction="column">
    <Box p="3" pb="0">
      <SegmentedControl.Root value={asideTab} onValueChange={(v) => setAsideTab(v as "markers" | "snippets")} style={{ width: "100%" }}>
        <SegmentedControl.Item value="markers">Markers</SegmentedControl.Item>
        <SegmentedControl.Item value="snippets">Snippets</SegmentedControl.Item>
      </SegmentedControl.Root>
    </Box>
    {asideTab === "markers" ? markersPanel : snippetsPanel}
  </Flex>;

  return <GraphLayout sidebar={sidebar} content={content} aside={asideShown && asidePanel} />;
}

/** Height of a small graph's time axis, in px. */
const PREVIEW_AXIS = 12;
/** Unchanged points shown on each side of a change in a diff, the one next to it included. */
const DIFF_CONTEXT = 3;
/** Past this many differences, a diff shows everything from the first to the last as changed. */
const DIFF_MAX = 500;
/** Width of the break where a diff leaves out unchanged points, in px. */
const DIFF_BREAK = 8;

/**
 * A stretch of a small graph, drawn right after the one before it whatever its
 * times: points of one script, with the unchanged points on each side of a
 * change. Moved points are drawn over where they were, the `old` points.
 */
interface Piece {
  kind: "plain" | "same" | "removed" | "added" | "moved" | "break";
  points: Action[];
  from?: Action;
  to?: Action;
  old?: Action[];
}

/** How each kind of piece draws: its line and points, whether dashed, and the band behind its points. */
const PIECE_STYLES: Record<Piece["kind"], { color: string; dashed?: boolean; band?: string }> = {
  plain: { color: LINE_COLOR },
  same: { color: "var(--gray-8)" },
  removed: { color: "var(--red-9)", dashed: true, band: "var(--red-a3)" },
  added: { color: "var(--green-9)", band: "var(--green-a3)" },
  moved: { color: "var(--gray-8)" },
  break: { color: "var(--gray-8)", dashed: true },
};

/**
 * Myers' diff of `a` and `b`: the index pairs of their longest common
 * subsequence, in order; null past `max` differences.
 */
function common(a: string[], b: string[], max: number): [number, number][] | null {
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  /** `v` before each step, to go back along the path. */
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) [x, y] = [x + 1, y + 1];
      v[off + k] = x;
      if (x < a.length || y < b.length) continue;
      const pairs: [number, number][] = [];
      for (let e = d; e > 0; e--) {
        const [w, k] = [trace[e], x - y];
        const prev = k === -e || (k !== e && w[off + k - 1] < w[off + k + 1]) ? k + 1 : k - 1;
        const [px, py] = [w[off + prev], w[off + prev] - prev];
        while (x > px && y > py) pairs.push([--x, --y]);
        [x, y] = [px, py];
      }
      while (x > 0 && y > 0) pairs.push([--x, --y]);
      return pairs.reverse();
    }
  }
  return null;
}

/**
 * A diff of two scripts' points like git's, as pieces of a small graph: each
 * change shows the points removed, then the points added, between a few
 * unchanged points; more unchanged points than that are left out. Points match
 * by depth and time since the point before, so a stretch that only shifted in
 * time stays unchanged. Points that all moved alike, all others unchanged, show
 * moved instead, over where they were.
 */
function diffPieces(before: Action[], after: Action[]): Piece[] {
  const pieces: Piece[] = [];
  const same = (from: number, to: number) => from < to && pieces.push({ kind: "same", points: after.slice(from, to) });
  if (before.length === after.length) {
    const changed = [...before.keys()].filter((i) => before[i].at !== after[i].at || before[i].pos !== after[i].pos);
    const [i0, i1] = [changed[0], changed[changed.length - 1]];
    const moved = (i: number) => [after[i].at - before[i].at, after[i].pos - before[i].pos].join();
    if (changed.length && changed.every((i) => moved(i) === moved(i0))) {
      same(Math.max(i0 - DIFF_CONTEXT, 0), i0);
      pieces.push({ kind: "moved", points: after.slice(i0, i1 + 1), old: before.slice(i0, i1 + 1), from: after[i0 - 1], to: after[i1 + 1] });
      same(i1 + 1, Math.min(i1 + 1 + DIFF_CONTEXT, after.length));
      return pieces;
    }
  }
  const key = (a: Action, i: number, all: Action[]) => `${a.at - (all[i - 1]?.at ?? 0)},${a.pos}`;
  const [kb, ka] = [before.map(key), after.map(key)];
  let start = 0;
  while (start < kb.length && start < ka.length && kb[start] === ka[start]) start++;
  let end = 0;
  while (end < kb.length - start && end < ka.length - start && kb[kb.length - 1 - end] === ka[ka.length - 1 - end]) end++;
  const pairs = common(kb.slice(start, kb.length - end), ka.slice(start, ka.length - end), DIFF_MAX) ?? [];
  /** The changes: the points before from `i0` to `i1` became the points after from `j0` to `j1`. */
  const hunks = [];
  let [i, j] = [start, start];
  for (const [pi, pj] of [...pairs.map(([a, b]) => [a + start, b + start]), [kb.length - end, ka.length - end]]) {
    let [i1, j1] = [pi, pj];
    // The point after an insert or delete only changed its time since the point before; it stays unchanged.
    // ponytail: also takes a replaced last point at the same depth as unchanged; compare the times past it if that misleads.
    while (i1 > i && j1 > j && before[i1 - 1].pos === after[j1 - 1].pos) [i1, j1] = [i1 - 1, j1 - 1];
    if (i1 > i || j1 > j) hunks.push({ i0: i, i1, j0: j, j1 });
    [i, j] = [pi + 1, pj + 1];
  }
  let shown = 0;
  hunks.forEach(({ i0, i1, j0, j1 }, h) => {
    if (h === 0) same(Math.max(j0 - DIFF_CONTEXT, 0), j0);
    else if (j0 - shown <= 2 * DIFF_CONTEXT) same(shown, j0);
    else {
      same(shown, shown + DIFF_CONTEXT);
      pieces.push({ kind: "break", points: [] });
      same(j0 - DIFF_CONTEXT, j0);
    }
    if (i1 > i0) pieces.push({ kind: "removed", points: before.slice(i0, i1), from: before[i0 - 1], to: before[i1] });
    if (j1 > j0) pieces.push({ kind: "added", points: after.slice(j0, j1), from: after[j0 - 1], to: after[j1] });
    shown = j1;
  });
  if (hunks.length) same(shown, Math.min(shown + DIFF_CONTEXT, after.length));
  return pieces;
}

/**
 * A small graph of `pieces` side by side, each as wide as its time, with
 * breaks in between; the time ticks show each piece's own times. `bands`,
 * times in the first piece's, show faintly behind, as regions do.
 */
function PreviewGraph({ pieces, bands = [] }: { pieces: Piece[]; bands?: { from: number; to: number }[] }) {
  if (!pieces.length) return <Text size="1" color="gray">No changes</Text>;
  const [width, plotHeight, pad] = [200, 60, 4];
  /** Moved points draw like removed ones where they were and added ones where they went, at the same times. */
  const layers = pieces.flatMap((p, i) => p.kind === "moved" ? [{ ...p, kind: "removed" as const, points: p.old!, i }, { ...p, kind: "added" as const, i }] : [{ ...p, i }]);
  const lines = layers.map((p) => [p.from, ...p.points, p.to].filter((a) => a !== undefined));
  const ends = (l: Action[]) => (l.length ? [l[0].at, l[l.length - 1].at] : []);
  const ranges = pieces.map((_, i) => {
    const all = layers.flatMap((l, k) => (l.i === i ? ends(lines[k]) : []));
    return all.length ? [Math.min(...all), Math.max(...all)] : [0, 0];
  });
  const breaks = pieces.filter((p) => p.kind === "break").length;
  const scale = (width - 2 * pad - breaks * DIFF_BREAK) / (ranges.reduce((sum, [a, b]) => sum + b - a, 0) || 1);
  let left = pad;
  const xs = pieces.map((p, i) => {
    const [from, x0] = [ranges[i][0], left];
    left += p.kind === "break" ? DIFF_BREAK : (ranges[i][1] - from) * scale;
    return (at: number) => x0 + (at - from) * scale;
  });
  const y = (pos: number) => pad + (1 - pos / 100) * (plotHeight - 2 * pad);
  // Each piece's own ticks, about three across the graph, left out where they would crowd the one before.
  const ticks: { x: number; label: string }[] = [];
  pieces.forEach((p, i) => {
    if (p.kind === "break") return;
    const [a, b] = ranges[i];
    const t = timeTicks(a / 1000, b / 1000, Math.max(1, Math.round((3 * (b - a) * scale) / (width - 2 * pad))));
    // Enough decimals to tell the ticks apart: their steps are 1, 2 or 5 times a power of ten below a second.
    const decimals = t.length > 1 ? Math.max(0, -Math.floor(Math.log10(t[1] - t[0]) + 1e-9)) : 1;
    for (const s of t) {
      const x = xs[i](s * 1000);
      if (x - (ticks[ticks.length - 1]?.x ?? -Infinity) >= 40) ticks.push({ x, label: formatScriptTime(s, decimals) });
    }
  });
  const dots = layers.reduce((n, p) => n + p.points.length, 0) <= 200;
  return (
    <svg width={width} height={plotHeight + PREVIEW_AXIS} style={{ display: "block" }}>
      {bands.map((b, k) => {
        const [x0, x1] = [clamp(xs[0](b.from), 0, width), clamp(xs[0](b.to), 0, width)];
        return <rect key={`band${k}`} x={x0} width={Math.max(x1 - x0, 1)} height={plotHeight} style={{ fill: "var(--cyan-a3)" }} />;
      })}
      {layers.map(({ kind, points, i }, l) => {
        const band = PIECE_STYLES[kind].band;
        const [a, b] = [points[0], points[points.length - 1]];
        return band && a && <rect key={l} x={xs[i](a.at)} width={Math.max(xs[i](b.at) - xs[i](a.at), 1)} y={0} height={plotHeight} style={{ fill: band }} />;
      })}
      {[0, 50, 100].map((pos) => (
        <line key={pos} x1={0} x2={width} y1={y(pos)} y2={y(pos)} style={{ stroke: "var(--gray-a5)" }} />
      ))}
      {ticks.map(({ x, label }) => {
        // Kept inside the graph at its edges.
        const anchor = x < 20 ? "start" : x > width - 20 ? "end" : "middle";
        return (
          <g key={x}>
            <line x1={x} x2={x} y1={0} y2={plotHeight} style={{ stroke: "var(--gray-a4)" }} />
            <text x={x} y={plotHeight + PREVIEW_AXIS - 2} textAnchor={anchor} fontSize={9} style={{ fill: "var(--gray-11)" }}>
              {label}
            </text>
          </g>
        );
      })}
      {/* Each moved point joined to where it went. */}
      {dots && pieces.flatMap((p, i) => (p.old ?? []).map((a, k) => (
        <line key={`${i}-${k}`} x1={xs[i](a.at)} y1={y(a.pos)} x2={xs[i](p.points[k].at)} y2={y(p.points[k].pos)} strokeWidth={1} style={{ stroke: PIECE_STYLES.moved.color }} />
      )))}
      {layers.map(({ kind, i }, l) => {
        const { color, dashed } = PIECE_STYLES[kind];
        const stroke = { stroke: color, strokeWidth: 1.5, strokeDasharray: dashed ? "3 2" : undefined };
        if (kind === "break") return <line key={l} x1={xs[i](0) + DIFF_BREAK / 2} x2={xs[i](0) + DIFF_BREAK / 2} y1={0} y2={plotHeight} {...stroke} />;
        return <polyline key={l} points={lines[l].map((a) => `${xs[i](a.at)},${y(a.pos)}`).join(" ")} fill="none" {...stroke} />;
      })}
      {dots && layers.flatMap(({ kind, points, i }, l) => points.map((a, k) => kind === "removed"
        ? <path key={`${l}-${k}`} d={`M${xs[i](a.at) - 2.5},${y(a.pos) - 2.5} l5,5 m0,-5 l-5,5`} strokeWidth={1.5} style={{ stroke: PIECE_STYLES.removed.color }} />
        : <circle key={`${l}-${k}`} cx={xs[i](a.at)} cy={y(a.pos)} r={kind === "added" ? 2.5 : 2} style={{ fill: PIECE_STYLES[kind].color }} />))}
      {pieces.flatMap((p, i) => [p.from, p.to].map((a, k) => a && <circle key={`${i}~${k}`} cx={xs[i](a.at)} cy={y(a.pos)} r={2} style={{ fill: "var(--gray-9)" }} />))}
    </svg>
  );
}

/** Changes a marker diff lists, past which it says how many more. */
const MARKER_DIFF_LINES = 4;

/**
 * A diff of two scripts' markers, like the points' one: a small lane over the
 * time they changed in, the markers as they were in red and dashed, as they
 * are in green, unchanged ones in grey, each moved one joined to where it
 * went; then the changes in words.
 */
function MarkerPreview({ before, after }: { before: Content; after: Content }) {
  // Edits keep the markers they leave alone, so the changed ones are those only one side has.
  const only = <T extends Marker>(a: T[], b: T[]) => {
    const kept = new Set(b);
    return a.filter((m) => !kept.has(m));
  };
  const lists = [[before.chapters, after.chapters], [before.bookmarks, after.bookmarks]] as const;
  const changes = lists.flatMap(([a, b]) => {
    const [gone, come] = [only<Marker>(a, b), only<Marker>(b, a)];
    // As many on each side, as a move or rename leaves, they pair up in time order.
    if (gone.length === come.length) return gone.map((old, i) => ({ old, now: come[i] as Marker | undefined, chapter: a === before.chapters }));
    return [...gone.map((old) => ({ old, now: undefined, chapter: a === before.chapters })), ...come.map((now) => ({ old: undefined as Marker | undefined, now, chapter: a === before.chapters }))];
  });
  const chapters = new Set([...before.chapters, ...after.chapters]);
  const span = (m: Marker) => (chapters.has(m as Chapter) ? [(m as Chapter).start, (m as Chapter).end] : [(m as Bookmark).time]);
  const times = changes.flatMap(({ old, now }) => [old, now].flatMap((m) => (m ? span(m) : [])));
  const [lo, hi] = [Math.min(...times), Math.max(...times)];
  const pad = Math.max((hi - lo) * 0.15, 2000);
  const [from, to] = [Math.max(lo - pad, 0), hi + pad];
  const [width, height, inset] = [200, 28, 4];
  const x = (at: number) => inset + ((at - from) / (to - from)) * (width - 2 * inset);
  const inRange = (m: Marker) => span(m).some((t) => t >= from && t <= to) || (span(m)[0] < from && span(m)[1] > to);
  const changed = new Set(changes.flatMap(({ old, now }) => [old, now]));
  const unchanged = [...after.chapters, ...after.bookmarks].filter((m) => !changed.has(m) && inRange(m));
  const when = (m: Marker) => span(m).map((t) => formatScriptTime(t / 1000, 2)).join("–");
  /** A marker drawn in `color`: a chapter as a band, a bookmark as a line. */
  const draw = (m: Marker, key: string, color: string, dashed: boolean, band?: string) => {
    const [a, b] = span(m);
    const stroke = { stroke: color, strokeWidth: 1.5, strokeDasharray: dashed ? "3 2" : undefined };
    return b === undefined
      ? <line key={key} x1={x(a)} x2={x(a)} y1={0} y2={height} {...stroke} />
      : <rect key={key} x={x(a)} width={Math.max(x(b) - x(a), 1)} y={height / 2} height={height / 2} style={{ fill: band ?? "none" }} {...stroke} />;
  };
  const ticks = timeTicks(from / 1000, to / 1000, 3);
  const lines = changes.map(({ old, now, chapter }) => {
    const kind = chapter ? "chapter" : "marker";
    if (!old) return `Added ${kind} ${now!.name} at ${when(now!)}`;
    if (!now) return `Deleted ${kind} ${old.name} at ${when(old)}`;
    const named = old.name === now.name ? old.name : `${old.name} → ${now.name}`;
    if (when(old) === when(now)) return `Renamed ${kind} ${named} at ${when(now)}`;
    const [a, b] = [span(old), span(now)];
    return `${chapter && a[1] - a[0] !== b[1] - b[0] ? "Resized" : "Moved"} ${kind} ${named} from ${when(old)} to ${when(now)}`;
  });
  return (
    <Flex direction="column" gap="1">
      <svg width={width} height={height + PREVIEW_AXIS} style={{ display: "block" }}>
        <rect width={width} height={height} rx={3} style={{ fill: "var(--gray-a2)" }} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t * 1000)} x2={x(t * 1000)} y1={0} y2={height} style={{ stroke: "var(--gray-a4)" }} />
            <text x={x(t * 1000)} y={height + PREVIEW_AXIS - 2} textAnchor="middle" fontSize={9} style={{ fill: "var(--gray-11)" }}>
              {formatTimeTick(t)}
            </text>
          </g>
        ))}
        {unchanged.map((m, i) => draw(m, `u${i}`, "var(--gray-8)", false, "var(--gray-a3)"))}
        {changes.map(({ old }, i) => old && draw(old, `o${i}`, PIECE_STYLES.removed.color, true, PIECE_STYLES.removed.band))}
        {changes.map(({ now }, i) => now && draw(now, `n${i}`, PIECE_STYLES.added.color, false, PIECE_STYLES.added.band))}
        {/* Each moved one joined to where it went, halfway up. */}
        {changes.map(({ old, now }, i) => old && now && span(old)[0] !== span(now)[0] && (
          <line key={`m${i}`} x1={x(span(old)[0])} x2={x(span(now)[0])} y1={height / 4} y2={height / 4} strokeWidth={1} style={{ stroke: PIECE_STYLES.moved.color }} />
        ))}
      </svg>
      {lines.slice(0, MARKER_DIFF_LINES).map((line, i) => <Text key={i} size="1" color="gray">{line}</Text>)}
      {lines.length > MARKER_DIFF_LINES && <Text size="1" color="gray">and {lines.length - MARKER_DIFF_LINES} more</Text>}
    </Flex>
  );
}

/**
 * `children`, a button, opening a small field for a name, `initial` at
 * first: Enter gives it, trimmed, to `onName`, unless it is empty or `taken`.
 */
function NamePopover({ initial = "", taken, onName, children }: { initial?: string; taken: (name: string) => boolean; onName: (name: string) => void; children: ReactElement }) {
  const [name, setName] = useState<string | null>(null);
  const refused = name === null || !name.trim() || taken(name.trim());
  return (
    <Popover.Root open={name !== null} onOpenChange={(open) => setName(open ? initial : null)}>
      <Popover.Trigger>{children}</Popover.Trigger>
      <Popover.Content size="1" width="200px">
        <Flex direction="column" gap="1">
          <TextField.Root
            size="1"
            aria-label="Name"
            value={name ?? ""}
            onFocus={(e) => e.target.select()}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || refused) return;
              onName(name.trim());
              setName(null);
            }}
          />
          {name?.trim() && refused && <Text size="1" color="red">That name is taken.</Text>}
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}

/**
 * Listen to `type` on the window with the latest `handler`. The listener is
 * added once: one re-added on every render can miss an event, when another
 * listener's state update re-renders while the event is being dispatched.
 */
function useWindowEvent<K extends keyof WindowEventMap>(type: K, handler: (e: WindowEventMap[K]) => void) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener = (e: WindowEventMap[K]) => latest.current(e);
    window.addEventListener(type, listener);
    return () => window.removeEventListener(type, listener);
  }, [type]);
}
