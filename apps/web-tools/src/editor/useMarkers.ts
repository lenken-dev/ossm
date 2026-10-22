import { useRef, useState, type Dispatch, type PointerEvent, type RefObject, type SetStateAction } from "react";
import { usePersistedState } from "../hooks/usePersistedState";
import { clamp } from "../funscript/model";
import { isChapter, timeOf, type Bookmark, type Chapter, type Marker } from "../funscript/markers";
import { pickRule, swapped, type Script } from "./model";
import { withBookmarks } from "./generate";
import type { Viewport } from "./viewport";

/** The marker selection, the marker lane's and the Markers panel's edits of the chapters and bookmarks, and their lock in the advanced editor. */
export interface Markers {
  /** The selected markers, moved, renamed and deleted together: a chapter, or bookmarks; selecting points or regions clears them, and they the regions. */
  marked: Set<Marker>;
  setMarked: Dispatch<SetStateAction<Set<Marker>>>;
  /** Select no markers. */
  clearMarked(): void;
  /** The advanced editor's marker lane and Markers panel take presses, and B adds a bookmark, editing the main script's markers. */
  unlocked: boolean;
  /** Lock the advanced editor's markers, or unlock them, selecting none. */
  toggleLock(): void;
  /**
   * The name field open over the time from `from` to `to` in the marker lane;
   * `done` gets the accepted name, or null to keep the old one. With `remove`,
   * it has a Delete button.
   */
  naming: { from: number; to: number; name: string; done: (name: string | null) => void; remove?: () => void } | null;
  /** Select the markers `ms`, clearing the point selection. */
  selectMarkers(ms: Iterable<Marker>): void;
  /** Ctrl/Cmd+A: with markers selected or the pointer over the lane, select every bookmark. Returns whether it did. */
  selectAll(): boolean;
  /**
   * Add a bookmark at `time` ms, with the last used name, and select it.
   * Without one yet, it opens its name field; naming it is part of adding it.
   */
  addBookmark(time: number): void;
  /**
   * A press on a marker selects it, and dragging it moves it: a chapter's
   * `sides`, both to move it, between its neighbours and 0 and at least 1 ms
   * long; a bookmark, with the other selected ones, anywhere from 0, past other
   * bookmarks. It never draws a chapter. Only bookmarks are selected together,
   * as by `markerPicked`. Pressed twice in a row, it opens the selection's
   * name field.
   */
  markerDown(e: PointerEvent<HTMLElement>, m: Marker, sides?: ("start" | "end")[]): void;
  /**
   * Select bookmarks together on a click on the bookmark `m` with a modifier:
   * Ctrl/Cmd toggles it in the selection, Shift selects the ones from the last
   * marker clicked without Shift, which any click on one without it makes `m`.
   * Returns whether it did.
   */
  markerPicked(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, m: Marker): boolean;
  /**
   * Open the name field on the markers `ms`, named as the first in time, to
   * give them all one name or delete them; a bookmark's accepted name is the
   * next one's.
   */
  rename(ms: Marker[]): void;
  /** Delete the markers `ms` as one edit, selecting none. */
  removeMarkers(ms: Marker[]): void;
  /** Close the name field with the accepted `name`, or null to keep the old one. */
  closeNaming(name: string | null): void;
  /** Delete the markers the name field is open on, and close it. */
  removeNamed(): void;
  /**
   * A press on empty lane: a drag draws a chapter, within the gap between the
   * chapters around it, and opens its name field; a click adds a bookmark.
   */
  laneDown(e: PointerEvent<HTMLDivElement>): void;
  /** The pointer came over the marker lane, where Ctrl/Cmd+A selects all bookmarks. */
  laneEnter(): void;
  /** The pointer left the marker lane. */
  laneLeave(): void;
}

/**
 * The marker selection and its edits of `chapters` and `bookmarks`, each an
 * `edit` and a drag `setDragging`; on the `viewport`'s time, a marker's drag
 * followed on `laneRef`. Selecting markers also does `onSelect`.
 */
export function useMarkers({ chapters, bookmarks, edit, setDragging, viewport, laneRef, onSelect }: {
  chapters: Chapter[];
  bookmarks: Bookmark[];
  edit: (label: string, next: SetStateAction<Script>) => void;
  setDragging: (dragging: boolean) => void;
  viewport: Viewport;
  laneRef: RefObject<HTMLDivElement | null>;
  onSelect: () => void;
}): Markers {
  const { pointerAt, track } = viewport;
  const [marked, setMarked] = useState<Set<Marker>>(() => new Set());
  const clearMarked = () => setMarked(new Set());
  const [unlocked, setUnlocked] = usePersistedState("ossm:editorMarkersUnlocked", false, localStorage);
  const toggleLock = () => {
    setUnlocked(!unlocked);
    clearMarked();
  };
  /** The marker last clicked without Shift, where a Shift+click range of bookmarks starts. */
  const markerAnchor = useRef<Marker | null>(null);
  /** Whether the pointer is over the marker lane. */
  const overLane = useRef(false);
  /** What a new bookmark is called: the name last given to one, for this visit to the page; none until then. */
  const [lastName, setLastName] = useState<string | null>(null);
  const [naming, setNaming] = useState<Markers["naming"]>(null);
  /** The marker last pressed and when, to tell a double-click: the drag's pointer capture keeps the browser's own from reaching the marker. */
  const lastPress = useRef<{ m: Marker; at: number } | null>(null);

  const selectMarkers = (ms: Iterable<Marker>) => {
    setMarked(new Set(ms));
    onSelect();
  };
  const selectAll = () => {
    if (!marked.size && !overLane.current) return false;
    selectMarkers(bookmarks);
    return true;
  };

  const addBookmark = (time: number) => {
    const added = { name: lastName ?? "Bookmark", time };
    if (lastName === null) setDragging(true);
    edit(`Add bookmark "${added.name}"`, (s) => withBookmarks(s, [...s.bookmarks, added].sort((a, b) => a.time - b.time)));
    selectMarkers([added]);
    markerAnchor.current = added;
    if (lastName !== null) return;
    setNaming({ from: time, to: time, name: added.name, done: (name) => {
      if (name) setLastName(name);
      if (name && name !== added.name) {
        const renamed = { ...added, name };
        edit(`Add bookmark "${name}"`, (s) => withBookmarks(s, s.bookmarks.map((b) => (b === added ? renamed : b))));
        setMarked(new Set([renamed]));
        markerAnchor.current = renamed;
      }
      setDragging(false);
    } });
  };

  const markerDown = (e: PointerEvent<HTMLElement>, m: Marker, sides: ("start" | "end")[] = ["start", "end"]) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (markerPicked(e, m)) return;
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
    const label = group.length > 1 ? `Move ${group.length} bookmarks` : `${isChapter(m) && sides.length === 1 ? "Resize" : "Move"} ${isChapter(m) ? "chapter" : "bookmark"} "${m.name}"`;
    const [origin, x0] = [pointerAt(e).at, e.clientX];
    let moved = false;
    setDragging(true);
    const move = (p: globalThis.PointerEvent) => {
      moved ||= Math.abs(p.clientX - x0) > 3;
      if (!moved) return;
      const dt = clamp(pointerAt(p).at - origin, dtMin, dtMax);
      // From where they started, so the lists from the press stay the ones to change.
      const to = new Map<Marker, Marker>(group.map((g) => [g, isChapter(g)
        ? { ...g, start: g.start + (sides.includes("start") ? dt : 0), end: g.end + (sides.includes("end") ? dt : 0) }
        : { ...g, time: g.time + dt }]));
      // The Markers regions follow each step, from the one before.
      edit(label, (s) => withBookmarks({ ...s, chapters: swapped(chapters, to) }, swapped(bookmarks, to).sort((a, z) => a.time - z.time)));
      setMarked(new Set(to.values()));
      markerAnchor.current = to.get(m)!;
    };
    // Scrolling stops where they can go no further that way.
    const scrolls = (dir: number, p: globalThis.PointerEvent) => {
      const dt = pointerAt(p).at - origin;
      return dir > 0 ? dt < dtMax : dt > dtMin;
    };
    // Followed on the graph and lane, which stay, not the marker: a flag's element can go out of view, or over to another bookmark, as it passes them.
    track(laneRef.current!, e, move, () => setDragging(false), scrolls);
  };

  const markerPicked = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, m: Marker) => {
    if (isChapter(m)) {
      markerAnchor.current = m;
      return false;
    }
    return pickRule(e, markerAnchor, m, (from) => {
      const [i, j] = [bookmarks.indexOf(from as Bookmark), bookmarks.indexOf(m)];
      selectMarkers(i < 0 ? [m] : bookmarks.slice(Math.min(i, j), Math.max(i, j) + 1));
    }, () => {
      const next = new Set([...marked].filter((o) => !isChapter(o)));
      if (!next.delete(m)) next.add(m);
      selectMarkers(next);
    });
  };

  const rename = (ms: Marker[]) => {
    ms = [...ms].sort((a, b) => timeOf(a) - timeOf(b));
    const times = ms.flatMap((m) => (isChapter(m) ? [m.start, m.end] : [m.time]));
    setNaming({ from: Math.min(...times), to: Math.max(...times), name: ms[0].name, remove: () => removeMarkers(ms), done: (name) => {
      if (name && !ms.every(isChapter)) setLastName(name);
      if (!name || ms.every((m) => m.name === name)) return;
      const to = new Map<Marker, Marker>(ms.map((m) => [m, { ...m, name }]));
      const label = ms.length > 1 ? `Rename ${ms.length} bookmarks` : `Rename ${isChapter(ms[0]) ? "chapter" : "bookmark"} "${ms[0].name}"`;
      edit(`${label} to "${name}"`, (s) => withBookmarks({ ...s, chapters: swapped(s.chapters, to) }, swapped(s.bookmarks, to)));
      setMarked(new Set(to.values()));
    } });
  };

  const removeMarkers = (ms: Marker[]) => {
    edit(ms.length > 1 ? `Delete ${ms.length} bookmarks` : `Delete ${isChapter(ms[0]) ? "chapter" : "bookmark"} "${ms[0].name}"`, (s) => withBookmarks({ ...s, chapters: s.chapters.filter((c) => !ms.includes(c)) }, s.bookmarks.filter((b) => !ms.includes(b))));
    clearMarked();
  };

  const closeNaming = (name: string | null) => {
    naming!.done(name);
    setNaming(null);
  };

  const removeNamed = () => {
    naming!.remove!();
    setNaming(null);
  };

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
    setDragging(true);
    const move = (m: globalThis.PointerEvent) => {
      if (!drawn && Math.abs(m.clientX - x0) <= 3) return;
      const t = clamp(pointerAt(m).at, lo, hi);
      if (t === at) return;
      const [old, chapter] = [drawn, { name: `Chapter ${n + 1}`, start: Math.min(at, t), end: Math.max(at, t) }];
      drawn = chapter;
      edit(`Add chapter "${chapter.name}"`, (s) => ({ ...s, chapters: [...s.chapters.filter((c) => c !== old), chapter].sort((a, b) => a.start - b.start) }));
    };
    // Scrolling stops at the gap's ends.
    const scrolls = (dir: number, m: globalThis.PointerEvent) => (dir > 0 ? pointerAt(m).at < hi : pointerAt(m).at > lo);
    track(e.currentTarget, e, move, () => {
      const chapter = drawn;
      if (!chapter) {
        setDragging(false);
        return addBookmark(at);
      }
      selectMarkers([chapter]);
      // The drag ends once named, so naming it is part of adding it.
      setNaming({ from: chapter.start, to: chapter.end, name: chapter.name, done: (name) => {
        if (name && name !== chapter.name) {
          const renamed = { ...chapter, name };
          edit(`Add chapter "${name}"`, (s) => ({ ...s, chapters: s.chapters.map((c) => (c === chapter ? renamed : c)) }));
          setMarked(new Set([renamed]));
        }
        setDragging(false);
      } });
    }, scrolls);
  };

  const laneEnter = () => void (overLane.current = true);
  const laneLeave = () => void (overLane.current = false);

  return { marked, setMarked, clearMarked, unlocked, toggleLock, naming, selectMarkers, selectAll, addBookmark, markerDown, markerPicked, rename, removeMarkers, closeNaming, removeNamed, laneDown, laneEnter, laneLeave };
}
