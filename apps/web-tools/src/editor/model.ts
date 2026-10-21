import { bisector } from "d3";
import { points, type Action } from "../funscript/model";
import type { Bookmark, Chapter, Marker } from "../funscript/markers";
import type { GenerateSetup, RepeatKept } from "./generate";

export interface Script {
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
export type Content = Pick<Script, "actions" | "chapters" | "bookmarks" | "regions">;
export const sameContent = (a: Content, b: Content) => a.actions === b.actions && a.chapters === b.chapters && a.bookmarks === b.bookmarks && a.regions === b.regions;

/** `list` with the markers in `to` swapped for what they map to. */
export const swapped = <T extends Marker>(list: T[], to: Map<Marker, Marker>) => list.map((m) => (to.get(m) as T | undefined) ?? m);

/** `set` with `item` in it if it wasn't, else without it. */
export const toggled = <T,>(item: T) => (set: Set<T>) => {
  const next = new Set(set);
  if (!next.delete(item)) next.add(item);
  return next;
};

/** A time range, in ms, and depth range. */
export interface Area {
  from: number;
  to: number;
  low: number;
  high: number;
}

/** The area with corners `a` and `b`. */
export const spanned = (a: Action, b: Action): Area => ({
  from: Math.min(a.at, b.at),
  to: Math.max(a.at, b.at),
  low: Math.min(a.pos, b.pos),
  high: Math.max(a.pos, b.pos),
});

/** `area` grown to take in `a`. */
export const extended = (area: Area, a: Action): Area => ({
  from: Math.min(area.from, a.at),
  to: Math.max(area.to, a.at),
  low: Math.min(area.low, a.pos),
  high: Math.max(area.high, a.pos),
});

/**
 * A stretch of points made by Generate: its box, times in whole ms, and its
 * own copy of the setup. Its points are the ones in its time; they are locked.
 */
export interface Generated extends Area {
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
export interface Instance {
  from: number;
  to: number;
  snippet: { name: string; regions: Inner[] };
}

/** A region made by a tool, which an instance can hold: Generate's or Repeat's, with the name given it, if any. */
export type Inner = (Generated | Repeated) & { name?: string };
/** A locked stretch of points: a generator region or a snippet instance. */
export type Region = Inner | Instance;
export const isInstance = (r: Region): r is Instance => "snippet" in r;
export const isRepeat = (r: Region): r is Repeated => "repeat" in r;
/** The Markers regions of `regions` and in their instances: those that put points on the bookmarks. */
export const markersRegions = (regions: Region[]) => generators(regions).filter((r): r is Generated => "generate" in r && r.generate.timing === "markers");
/** What the undo history calls `r`: a region, or a snippet by its name. */
export const regionNoun = (r: Region) => (isInstance(r) ? `snippet "${r.snippet.name}"` : r.name ? `region "${r.name}"` : "region");

/** An instance named `name` of `clip`'s points and its generator regions: from its first to its last point, widened to their boxes. */
export const instanceOf = (name: string, clip: Clip): Instance => {
  const inner = generators(clip.regions);
  const { actions } = clip;
  return { from: Math.min(actions[0].at, ...inner.map((r) => r.from)), to: Math.max(actions[actions.length - 1].at, ...inner.map((r) => r.to)), snippet: { name, regions: inner } };
};

/** The generator regions of `regions` and in their instances. */
export const generators = (regions: Region[]) => regions.flatMap((r) => (isInstance(r) ? r.snippet.regions : [r]));

/** The region of `regions` whose time holds `at`; none outside them. */
export const regionAt = (regions: Region[], at: number) => regions.find((r) => at >= r.from && at <= r.to);

/** `r` moved `dt` ms in time, an instance's regions with it. */
export const movedBy = <R extends Region>(r: R, dt: number): R =>
  ({ ...r, from: r.from + dt, to: r.to + dt, ...(isInstance(r) && { snippet: { ...r.snippet, regions: r.snippet.regions.map((i) => movedBy(i, dt)) } }) });

/** Points to place, timed from the first, with the regions they carry, timed alike: copied, pasted, moved or the advanced editor's result. */
export interface Clip {
  actions: Action[];
  regions: Region[];
}

/** A clip being placed, with which of its points and regions are `picked`, what its edit is called, the time its first point came `from` and the point dragged by, its `grip`; see `placing`. */
export type Placing = Clip & { picked?: { actions: boolean[]; regions: boolean[] }; label?: string; from?: number; grip?: number };

/** What the undo history calls `n` points and the regions `rs` together. */
export const items = (n: number, rs: Region[]) => [n ? points(n) : "", rs.length === 1 ? regionNoun(rs[0]) : rs.length ? `${rs.length} regions` : ""].filter(Boolean).join(" and ");

/** `clip` moved `dt` ms in time, its regions with it. */
export const clipBy =(clip: Clip, dt: number): Clip => ({ actions: clip.actions.map((a) => ({ at: a.at + dt, pos: a.pos })), regions: clip.regions.map((r) => movedBy(r, dt)) });

/** What made a region, after the timing that placed its points. */
export const regionKind = (r: Region) => (isInstance(r) ? "Snippet" : isRepeat(r) ? `Repeat · ×${r.repeat.count}` : `Generate · ${r.generate.timing[0].toUpperCase()}${r.generate.timing.slice(1)}`);
/** A region's label: an instance's by its name, another's its name or else what made it. */
export const regionName = (r: Region) => (isInstance(r) ? `Snippet · ${r.snippet.name}` : r.name ?? regionKind(r));

/** How a region's band behind the graph fills and outlines, and its label's colour: cyan, an instance's violet, a Repeat one's orange; selected, it fills stronger and outlines as the selected markers. */
export const bandOf = (r: Region) => {
  const c = isInstance(r) ? "violet" : isRepeat(r) ? "orange" : "cyan";
  return { fill: `var(--${c}-a3)`, selectedFill: `var(--${c}-a5)`, stroke: `var(--${c}-a8)`, label: `var(--${c}-11)` };
};

/**
 * The advanced editor's document, which the page edits instead of the main
 * script while it is open: its points, in the main script's times, its 0, and
 * the indices of the main script's points it was opened from, null when opened empty;
 * and its regions. In snippet mode, the library snippet it edits, by its
 * folders' and its own name, or null for a new one: Done saves it to the
 * library instead of placing it.
 */
export interface Advanced {
  actions: Action[];
  regions: Region[];
  zero: number;
  from: number[] | null;
  snippet?: { path: string[] | null };
  /** Editing an instance, its index in the main script's regions: Done gives one instance of its name. */
  instance?: number;
}

export const EMPTY: Script = { name: "untitled", actions: [], chapters: [], bookmarks: [], regions: [] };

export const byTime = bisector((a: Action) => a.at).left;
export const afterTime = bisector((a: Action) => a.at).right;
