import type { Marker } from "../funscript/markers";
import type { Content, Region } from "./model";
import type { Entry } from "./library";
import { withBookmarks } from "./generate";

/** What is selected: points by index, regions and markers. */
interface Selection {
  points: Set<number>;
  regions: Set<Region>;
  markers: Set<Marker>;
}

/** An undo history entry: the content after an edit, what the edit is called, the snippet library with it, and the selection last made on it. */
interface Step extends Content {
  label: string;
  library: Entry[];
  selection?: Selection;
}

/** An undo history: its entries, and `index`, the current one. */
export interface Timeline {
  states: Step[];
  index: number;
}

/** An undo history starting at `c` with the snippet library `library`, its first entry called `label`. */
export const startedAt = ({ actions, chapters, bookmarks, regions }: Content, library: Entry[], label: string): Timeline =>
  ({ states: [{ actions, chapters, bookmarks, regions, library, label }], index: 0 });

/**
 * `tl` going on with the snippet library's changes in the undo history
 * `from`, up to its current entry, and with `markers` the markers', as the
 * advanced editor makes with its lane unlocked. Each is an entry of its own
 * with `tl`'s current points and regions, its Markers regions' points
 * following the bookmarks, so they stay undoable when `from` goes; `tl`'s
 * undone entries go.
 */
export function withLibraryChanges(tl: Timeline, from: Timeline, markers = false): Timeline {
  const { regions } = tl.states[tl.index];
  let { actions, chapters, bookmarks } = tl.states[tl.index];
  const steps = from.states.slice(0, from.index + 1);
  const shared = (st: Step, k: number) => st.library !== steps[k - 1].library || (markers && (st.chapters !== steps[k - 1].chapters || st.bookmarks !== steps[k - 1].bookmarks));
  const changes = steps.filter((st, k) => k > 0 && shared(st, k)).map((st) => {
    if (markers) ({ actions, chapters, bookmarks } = withBookmarks({ actions, chapters: st.chapters, bookmarks, regions }, st.bookmarks));
    return { actions, chapters, bookmarks, regions, library: st.library, label: st.label };
  });
  const states = [...tl.states.slice(0, tl.index + 1), ...changes].slice(-UNDO_SIZE - 1);
  return { states, index: states.length - 1 };
}

/**
 * The time range of what differs between `a` and `b`, null when nothing
 * does: the points, by value, past those alike at either end, and the markers
 * and regions only one has, as edits keep the ones they leave alone.
 */
export function changedSpan(a: Content, b: Content) {
  const same = (i: number, j: number) => a.actions[i].at === b.actions[j].at && a.actions[i].pos === b.actions[j].pos;
  let start = 0;
  while (start < a.actions.length && start < b.actions.length && same(start, start)) start++;
  let end = 0;
  while (end < a.actions.length - start && end < b.actions.length - start && same(a.actions.length - 1 - end, b.actions.length - 1 - end)) end++;
  const only = <T,>(p: T[], q: T[]) => {
    const kept = new Set(q);
    return p.filter((m) => !kept.has(m));
  };
  const times = [a, b].flatMap((x) => x.actions.slice(start, x.actions.length - end).map((p) => p.at));
  for (const [p, q] of [[a, b], [b, a]]) {
    times.push(...only(p.chapters, q.chapters).flatMap((c) => [c.start, c.end]), ...only(p.bookmarks, q.bookmarks).map((m) => m.time), ...only(p.regions, q.regions).flatMap((r) => [r.from, r.to]));
  }
  return times.length ? { from: times.reduce((m, t) => Math.min(m, t)), to: times.reduce((m, t) => Math.max(m, t)) } : null;
}

/** Copies kept in the clipboard history. */
export const HISTORY_SIZE = 10;
/** Edits kept for undo. */
export const UNDO_SIZE = 100;
