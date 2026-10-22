import { useEffect, useMemo, useRef, useState, type PointerEvent, type SetStateAction } from "react";
import { clamp, type Action } from "../funscript/model";
import { afterTime, byTime, items, markersRegions, movedBy, regionAt, stretchOf, type Area, type Placing, type Region, type Script } from "./model";
import { refilled } from "./generate";
import type { Grid } from "./useGrid";
import type { Tools } from "./useTool";
import type { View, Viewport } from "./viewport";

/** What is being placed: the points following the pointer or a drag until placed, the stretch lifted for a move, and where they would land. */
export interface Placement {
  /**
   * Points being placed, timed from the first, with the regions they carry,
   * following the pointer until a click or a drag's release places them; with
   * the `picked` ones of them, the selection being moved, which alone take the
   * depth change and are selected once placed (all without), what the edit
   * is called and, moved or added, the time its first point came from.
   */
  placing: Placing | null;
  /**
   * The stretch of the script being moved, from its first to its last
   * selected item, left out of the script with every point and region in it,
   * the gap closed, until placed, with the selection to put back on Escape.
   * None for a paste.
   */
  lifted: { from: number; to: number; points: Set<number>; regions: Region[] } | null;
  /**
   * Start placing `clip`, lifted from `lifted` (none: a paste), its first
   * point `at` (else where the pointer last was); `settle` it at once: see
   * where `settle` is used.
   */
  start(clip: Placing, opts?: { at?: Action; lifted?: Placement["lifted"]; settle?: "drop" | "try" }): void;
  /** Stop placing points; moved ones go back where they were, still selected, in selection mode with the box around them. */
  cancel(): void;
  /** Stop placing points, leaving the script and the selection as they are. */
  drop(): void;
  /** The pointer moved over the graph: what is being placed follows it, unless a drag carries it, with the modifiers held. */
  hover(e: { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): void;
  /** The pointer left the graph: what is being placed hides, unless a drag carries it. */
  leave(): void;
  /**
   * Follow a drag from `e` with what is being placed, its first point at
   * `start` as pressed; without one, once it has gone 3 px, with the
   * selection `ps`, `rs` lifted, by the point `grabbed`. Released, it goes in.
   */
  carry(e: PointerEvent<Element>, start: Action | null, ps?: number[], rs?: Region[], grabbed?: number): void;
  /** Put what is being placed in at the pointer, where it lands, unless refused there. */
  putAt(e: PointerEvent<Element>): void;
  /** A click places what is being placed at the pointer, as `putAt`. */
  place(e: PointerEvent<SVGRectElement>): void;
  /** What the graph draws. */
  drawn: {
    /** The points being placed where the pointer puts them. */
    ghost: Action[] | null;
    /** Where they go in; none where they can't, as they would cut into a region, and they show red. */
    landed: Action[] | null;
    /** Whether they can't go in where the pointer puts them. */
    refused: boolean;
    /** The points as drawn: placing, as they would be once placed. */
    shown: Action[];
    /** The regions as drawn, with the points. */
    shownRegions: Region[];
    /** The selected points as drawn: placing, the picked ones; with a tool open, the affected ones in its result. */
    marks: Set<number>;
    /** Whether the region `r` is drawn selected: a selected one, or a picked one being placed. */
    outlined(r: Region): boolean;
    /** Where they can't go in, their points, the time they cover there and the regions they carry, drawn red over the rest. */
    astray: { points: Action[]; span: number[]; carried: Region[] } | null;
    /** Replacing, the line through the points they would take out, from the point before to the one after, drawn faint red and dashed, as removed points in the undo history. */
    removed: Action[] | null;
    /** The point being placed or dragged apart dragged by, else the first, where it came from: a paste's depth alone, as it came from no time. */
    dragged: { at: number | undefined; pos: number } | undefined;
    /**
     * Modifiers held while placing or dragging apart: Shift replaces the
     * points covered instead of inserting, Ctrl (or Cmd) keeps the copied
     * depths instead of following the pointer's, or moved or added points
     * their time; see `upright`.
     */
    held: { shift: boolean; ctrl: boolean };
    /**
     * The points that stay while placing: the lifted stretch's time goes, with
     * every point in it, and the later points move left by as much, as do the
     * regions after it; inserting it back there undoes it. A moved Markers
     * region's points go on the bookmarks in its new box.
     */
    kept: Action[];
  };
}

/**
 * What is being placed, on the `viewport`'s time and depth, and the
 * `script`'s stretch lifted to move it: lifting `select`s nothing and drops
 * the box with `setBox`; put in as an `edit`, the picked ones are selected,
 * with `fitBox` around them. It snaps to the `grid`, or `onMarkers` to the
 * nearest bookmark, and keeps off the regions it would cut into while their
 * edges are in `view`. Drawn as it would go in, else as the tool's
 * `preview` or the script, with the `selected` points and
 * `regionsOn`. A selection dragged apart is dragged by `apartGrip`.
 */
export function usePlacing({ script, view, viewport, selected, regionsOn, onMarkers, grid, preview, apartGrip, edit, select, setBox, fitBox }: {
  script: Script;
  view: View;
  viewport: Viewport;
  selected: Set<number>;
  regionsOn: Set<Region>;
  onMarkers: boolean;
  grid: Grid;
  preview: Tools["preview"];
  apartGrip: Action | undefined;
  edit: (label: string, next: SetStateAction<Script>) => void;
  select: (ps: Iterable<number>, rs?: Iterable<Region>) => void;
  setBox: (area: Area | null) => void;
  fitBox: (ps: Action[], rs: Region[], on?: Action[]) => void;
}): Placement {
  const { actions, bookmarks, regions } = script;
  const { x, y, pointerAt, track } = viewport;
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [lifted, setLifted] = useState<Placement["lifted"]>(null);
  /** Where the first point being placed is, under the pointer. */
  const [placeAt, setPlaceAt] = useState<Action | null>(null);
  /** Set while a drag carries what is being placed, which then follows the drag, not the pointer's moves over the graph. */
  const carrying = useRef(false);
  /** Set on a drag's release, to put in what it carried, or by Done, to put in its result; see where it is used. */
  const [settle, setSettle] = useState<"drop" | "try" | null>(null);
  const [held, setHeld] = useState({ shift: false, ctrl: false });
  const inserting = !held.shift;
  /** The regions that stay while placing, with `kept`'s points: those in the lifted stretch go, and later ones move left as their points do. */
  const keptRegions = useMemo(() => {
    if (!lifted) return regions;
    const { from, to } = lifted;
    return regions.filter((r) => r.to < from || r.from > to).map((r) => (r.from > to ? movedBy(r, from - to) : r));
  }, [regions, lifted]);
  const kept = useMemo(() => {
    if (!lifted) return actions;
    const { from, to } = lifted;
    const closed = [...actions.slice(0, byTime(actions, from)), ...actions.slice(afterTime(actions, to)).map((a) => ({ at: a.at - (to - from), pos: a.pos }))];
    const shifted = to > from ? markersRegions(keptRegions).filter((r) => r.from > from) : [];
    return shifted.reduce((list, r) => refilled(list, r, bookmarks), closed);
  }, [actions, lifted, keptRegions, bookmarks]);

  /**
   * Lift the selection, the points `ps` and the regions `rs`, to place it
   * again: the stretch from its first to its last item, with every point and
   * region in it, the gap closing behind it, dragged by the point `grabbed`.
   * Returns its first point; null when it has none, as there is nothing to place.
   */
  const lift = (ps: number[], rs: Region[], grabbed?: number) => {
    const { from, to } = stretchOf(ps.map((i) => actions[i]), rs);
    const [lo, hi] = [byTime(actions, from), afterTime(actions, to)];
    if (lo === hi) return null;
    const first = actions[lo];
    // Regions don't overlap and the selected points are outside them, so a region in the stretch is wholly in it.
    const inner = regions.filter((r) => r.from >= from && r.to <= to);
    const own = new Set(ps);
    setPlacing({
      actions: actions.slice(lo, hi).map((a) => ({ at: a.at - first.at, pos: a.pos })),
      regions: inner.map((r) => movedBy(r, -first.at)),
      picked: { actions: actions.slice(lo, hi).map((_, j) => own.has(lo + j)), regions: inner.map((r) => rs.includes(r)) },
      from: first.at,
      grip: grabbed === undefined ? undefined : grabbed - lo,
    });
    setLifted({ from, to, points: own, regions: rs });
    setPlaceAt(first);
    select([]);
    setBox(null);
    return first;
  };

  const carry = (e: PointerEvent<Element>, start: Action | null, ps: number[] = [], rs: Region[] = [], grabbed?: number) => {
    e.preventDefault();
    e.stopPropagation();
    const origin = pointerAt(e);
    const [x0, y0] = [e.clientX, e.clientY];
    carrying.current = !!start;
    track(e.currentTarget.closest("svg")!, e, (m) => {
      if (!start && (Math.hypot(m.clientX - x0, m.clientY - y0) <= 3 || !(start = lift(ps, rs, grabbed)))) return;
      carrying.current = true;
      const p = pointerAt(m);
      setPlaceAt({ at: start!.at + p.at - origin.at, pos: start!.pos + p.pos - origin.pos });
    }, () => {
      carrying.current = false;
      if (start) setSettle("drop");
    });
  };

  const start: Placement["start"] = (clip, { at, lifted = null, settle } = {}) => {
    setPlacing(clip);
    setLifted(lifted);
    if (at) setPlaceAt(at);
    if (settle) setSettle(settle);
  };

  const cancel = () => {
    if (lifted) {
      select(lifted.points, lifted.regions);
      fitBox([...lifted.points].map((i) => actions[i]), lifted.regions);
    }
    drop();
  };

  const drop = () => {
    setPlacing(null);
    setLifted(null);
  };

  const hover: Placement["hover"] = (e) => {
    if (placing && !carrying.current) setPlaceAt(pointerAt(e));
    setHeld({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
  };

  const leave = () => !carrying.current && setPlaceAt(null);

  /**
   * The points being placed with the first at `at`, `pos`; they keep their
   * shape and stay within 0–100, and their regions from 0 on. Only the picked
   * ones take the depth change, and none carrying regions, which keep their
   * depths, as the regions' boxes do. Locked, they keep their time instead
   * where `upright`. The point dragged by, else the first, goes on the grid's depths.
   */
  const positioned = (at: number, pos: number, lock: boolean) => {
    const { actions: shape, regions, picked, from, grip } = placing!;
    const keepTime = lock && upright(at, pos);
    const keepDepth = lock && !keepTime;
    if (keepTime) at = from!;
    const follows = (j: number) => !picked || picked.actions[j];
    const depths = shape.filter((_, j) => follows(j)).map((a) => a.pos);
    const lead = shape[grip ?? 0].pos;
    const dp = keepDepth || regions.length || !depths.length ? 0 : clamp(grid.pos(lead + pos - shape[0].pos) - lead, -Math.min(...depths), 100 - Math.max(...depths));
    const first = Math.max(at, 0, ...regions.map((r) => -r.from));
    return shape.map((a, j) => ({ at: first + a.at, pos: follows(j) ? a.pos + dp : a.pos }));
  };

  /**
   * Whether the points being placed with the first at `at`, `pos` are further
   * on screen from where they came from in depth than in time; never for a
   * paste, which came from no time.
   */
  const upright = (at: number, pos: number) => {
    const { actions: shape, from } = placing!;
    return from !== undefined && Math.abs(y(pos) - y(shape[0].pos)) > Math.abs(x(at) - x(from));
  };

  /** The time `at` of the first point being placed: placing on markers, on the nearest bookmark out of the regions; else with the point dragged by, or the first, on the grid. */
  const snapAt = (at: number) => {
    const free = onMarkers ? bookmarks.filter((b) => !regionAt(keptRegions, b.time)) : [];
    if (free.length) return free.reduce((a, b) => (Math.abs(b.time - at) < Math.abs(a.time - at) ? b : a)).time;
    const lead = placing!.actions[placing!.grip ?? 0].at;
    return grid.at(at + lead) - lead;
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
   * time `pasted` covers. Both with the regions they carry. A point at a
   * pasted one's time goes, as that takes its place, when it is one or when
   * placing on markers, where it takes its marker.
   */
  const around = (pasted: Action[], insert: boolean) => {
    const [start, end] = spanOf(pasted);
    const times = pasted.length === 1 || onMarkers ? new Set(pasted.map((a) => a.at)) : null;
    const base = times ? kept.filter((a) => !times.has(a.at)) : kept;
    const before = base.slice(0, byTime(base, start));
    if (!insert) return { before, after: base.slice(afterTime(base, end)), regions: keptRegions };
    const later = base.slice(before.length);
    // The first point or region moved goes at least 1 ms past them.
    const next = Math.min(later[0]?.at ?? Infinity, ...keptRegions.filter((r) => r.from >= start).map((r) => r.from));
    const shift = Number.isFinite(next) ? Math.max(end - start, end + 1 - next) : 0;
    const regions = keptRegions.map((r) => (r.from >= start ? movedBy(r, shift) : r));
    const shifted = shift ? markersRegions(regions).filter((r) => r.from >= start + shift) : [];
    const after = shifted.reduce((list, r) => refilled(list, r, bookmarks), later.map((a) => ({ at: a.at + shift, pos: a.pos })));
    return { before, after, regions };
  };

  /**
   * `pasted` where it can go in, off the regions it would cut into, against
   * the edge nearest it of such a region, while that edge is in view:
   * inserting, from an edge of the region its start is in; replacing, the
   * first such place where it covers none. Null where it can't.
   */
  const landing = (pasted: Action[], insert: boolean) => {
    const [start, end] = spanOf(pasted);
    const by = (dt: number) => pasted.map((a) => ({ at: a.at + dt, pos: a.pos }));
    const seen = (t: number) => t >= view.from && t <= view.from + view.span;
    if (insert) {
      const splits = (t: number) => keptRegions.some((r) => r.from < t && t <= r.to);
      if (!splits(start)) return pasted;
      const r = keptRegions.find((r) => r.from < start && start <= r.to)!;
      // Just before it, or just after it, where that splits no other.
      const spot = [[r.from, r.from - 1 - start], [r.to, r.to + 1 - start]]
        .sort(([, a], [, b]) => Math.abs(a) - Math.abs(b))
        .find(([t, dt]) => seen(t) && start + dt >= 0 && !splits(start + dt));
      return spot ? by(spot[1]) : null;
    }
    const over = (dt: number) => keptRegions.filter((r) => r.from <= end + dt && r.to >= start + dt);
    if (!over(0).length) return pasted;
    const spot = over(0)
      .flatMap((o) => [[o.from, o.from - 1 - end], [o.to, o.to + 1 - start]])
      .sort(([, a], [, b]) => Math.abs(a) - Math.abs(b))
      .find(([t, dt]) => !seen(t) || (start + dt >= 0 && !over(dt).length));
    return spot && seen(spot[0]) ? by(spot[1]) : null;
  };

  /**
   * `pasted` as it goes in: its points, a Markers region's on the bookmarks
   * under it, the regions it carries, and of those the picked ones, its
   * points by index, but the regions'.
   */
  const goingIn = (pasted: Action[]) => {
    const { picked } = placing!;
    const placed = filledIn(pasted);
    const carried = carriedBy(pasted);
    const times = picked && new Set(pasted.filter((_, j) => picked.actions[j]).map((a) => a.at));
    return {
      placed,
      carried,
      points: placed.flatMap((a, j) => (regionAt(carried, a.at) || (times && !times.has(a.at)) ? [] : [j])),
      regions: carried.filter((_, k) => !picked || picked.regions[k]),
    };
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
   * they carry, each with its own copy of the setup, and select the picked
   * ones; in selection mode, with the box around them.
   */
  const put = (pasted: Action[], insert: boolean) => {
    const { before, after, regions } = around(pasted, insert);
    const { placed, carried, points: own, regions: picked } = goingIn(pasted);
    const copies = carried.map((r) => structuredClone(r));
    const chosenCopies = copies.filter((_, k) => picked.includes(carried[k]));
    const next = [...before, ...placed, ...after];
    edit(placing!.label ?? `${lifted ? "Move" : "Paste"} ${items(own.length, chosenCopies)}`, { ...script, actions: next, regions: copies.length ? [...regions, ...copies].sort((a, b) => a.from - b.from) : regions });
    select(own.map((j) => before.length + j), chosenCopies);
    fitBox(own.map((j) => placed[j]), chosenCopies, next);
    drop();
  };

  const putAt = (e: PointerEvent<Element>) => {
    const [pasted, insert] = landedAt(e);
    if (pasted) put(pasted, insert);
  };

  const place = (e: PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    putAt(e);
  };

  /** What is being placed at the pointer where it lands, null where refused, and whether it would insert, by the modifiers held. */
  const landedAt = (e: { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const point = pointerAt(e);
    const insert = !e.shiftKey;
    return [landing(positioned(snapAt(point.at), point.pos, e.ctrlKey || e.metaKey), insert), insert] as const;
  };

  const ghost = placing && placeAt ? positioned(snapAt(placeAt.at), placeAt.pos, held.ctrl) : null;
  const landed = ghost && landing(ghost, inserting);
  const refused = !!ghost && !landed;
  /** As they would go in, and the script around them, drawn so. */
  const going = landed && goingIn(landed);
  const dropped = landed && around(landed, inserting);
  const shown = going && dropped ? [...dropped.before, ...going.placed, ...dropped.after] : preview?.actions ?? kept;
  const shownRegions = going && dropped ? [...dropped.regions, ...going.carried] : preview?.regions ?? keptRegions;
  const marks = going && dropped ? new Set(going.points.map((j) => dropped.before.length + j)) : preview?.selected ?? selected;
  const outlined = (r: Region) => regionsOn.has(r) || !!going?.regions.includes(r);
  const astray = refused ? { points: filledIn(ghost), span: spanOf(ghost), carried: carriedBy(ghost) } : null;
  const removed = landed && !inserting ? (() => {
    const [start, end] = spanOf(landed);
    const [lo, hi] = [byTime(kept, start), afterTime(kept, end)];
    return lo < hi ? kept.slice(Math.max(lo - 1, 0), hi + 1) : null;
  })() : null;
  const dragged = placing && placeAt ? { at: placing.from === undefined ? undefined : placing.from + placing.actions[placing.grip ?? 0].at, pos: placing.actions[placing.grip ?? 0].pos } : apartGrip;

  // A drag's release, or Done, goes in once rendered with where it lands; refused there, a drag goes back, and Done's result follows the pointer as a paste.
  useEffect(() => {
    if (!settle) return;
    setSettle(null);
    if (landed) put(landed, inserting);
    else if (settle === "drop") cancel();
  }, [settle]);

  return { placing, lifted, start, cancel, drop, hover, leave, carry, putAt, place, drawn: { ghost, landed, refused, shown, shownRegions, marks, outlined, astray, removed, dragged, held, kept } };
}
