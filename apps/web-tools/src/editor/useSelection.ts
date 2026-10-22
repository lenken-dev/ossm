import { useMemo, useRef, useState, type Dispatch, type PointerEvent, type SetStateAction } from "react";
import { usePersistedState } from "../hooks/usePersistedState";
import { clamp, type Action } from "../funscript/model";
import { afterTime, byTime, extended, regionAt, spanned, type Area, type Region } from "./model";
import type { Viewport } from "./viewport";

/** The point and region selection, and selection mode's box. */
export interface Selecting {
  /** Indices of the selected points, moved together with the selected regions and deleted with the Delete key. */
  selected: Set<number>;
  setSelected: Dispatch<SetStateAction<Set<number>>>;
  /** The selected regions, selected, moved and deleted with the points; only while in the script. */
  regionsOn: Set<Region>;
  setRegionsOn: Dispatch<SetStateAction<Set<Region>>>;
  /** Select the points `ps` and the regions `rs`, and nothing else. */
  select(ps: Iterable<number>, rs?: Iterable<Region>): void;
  /** The selected regions while in the script; they go with an edit that replaces them. */
  chosen: Region[];
  /** The selected region when it is all that is selected, which its panel shows. */
  region: Region | null;
  /** Whether there is something to copy: selected points, or a selected region with points. */
  copyable: boolean;
  /**
   * Selection mode: dragging on empty space draws a box that selects points
   * instead of adding one, and the box stays to be resized or moved; only the
   * points in it are selected. Otherwise Shift draws one that goes when released.
   */
  boxMode: boolean;
  /** Selection mode's box selects by time: it takes in whole stretches of the script, whatever their depth. */
  selectByTime: boolean;
  setSelectByTime: Dispatch<SetStateAction<boolean>>;
  box: Area | null;
  setBox(area: Area | null, on?: Action[]): void;
  /** The selection box's sides, in px. */
  edges: { from: number; to: number; low: number; high: number } | null;
  /** Show `area` as the selection box and select the points and regions in it and in `base`. */
  selectIn(area: Area, base?: { points: Iterable<number>; regions: Region[] }): void;
  /** `area` as selection mode's box, over every depth when selecting by time. */
  boxed(area: Area): Area;
  /** The box around the points `ps` and the regions `rs`, over every depth for regions alone. */
  boxAround(ps: Action[], rs: Region[]): Area;
  /**
   * Draw a box from the pointer and select the points and regions in it. In
   * selection mode the box replaces the selection and stays; otherwise (with
   * Shift) they add to it and the box goes when released. A click without
   * dragging is `click`, or clears the selection.
   */
  boxSelect(e: PointerEvent<SVGSVGElement>, click?: () => void): void;
  /**
   * Drag the `sides` of the selection box: an edge or corner resizes it, all
   * four move it. Only the points and regions in it are selected.
   */
  editBox(e: PointerEvent<SVGRectElement>, sides: (keyof Area)[]): void;
  /**
   * Pick the item from `from` to `to` ms, a point or a region, clicked with
   * a modifier: Ctrl/Cmd toggles it in the selection with `toggle`, Shift
   * selects every point and region from the last clicked item to it. Returns
   * whether it did.
   */
  picked(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, from: number, to: number, toggle: () => void): boolean;
  /** Switch selection mode, not while placing. Entered with a selection, the box fits around it, selecting what is in it. */
  toggleBoxMode(): void;
}

/**
 * The selection of the `actions`' points, but the `regions`' ones, and of the
 * regions, and selection mode's box, drawn and dragged on the `viewport`;
 * selection mode does not switch while `placing`.
 */
export function useSelection({ actions, regions, viewport, placing }: {
  actions: Action[];
  regions: Region[];
  viewport: Viewport;
  placing: boolean;
}): Selecting {
  const { x, y, pointerAt, track } = viewport;
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [regionsOn, setRegionsOn] = useState<Set<Region>>(() => new Set());
  const select = (ps: Iterable<number>, rs: Iterable<Region> = []) => {
    setSelected(new Set(ps));
    setRegionsOn(new Set(rs));
  };
  const [boxMode, setBoxMode] = useState(false);
  const [selectByTime, setSelectByTime] = usePersistedState("ossm:editorSelectByTime", false, localStorage);
  /** The selection box, with the points it was drawn on; it goes when they change. */
  const [boxOn, setBoxOn] = useState<{ area: Area; actions: Action[] } | null>(null);
  const box = boxOn?.actions === actions ? boxOn.area : null;
  const setBox = (area: Area | null, on = actions) => setBoxOn(area && { area, actions: on });
  /** The point or region last clicked without Shift, by its time, where a Shift+click range starts. */
  const anchor = useRef<{ from: number; to: number } | null>(null);
  const chosen = useMemo(() => regions.filter((r) => regionsOn.has(r)), [regions, regionsOn]);
  const region = !selected.size && chosen.length === 1 ? chosen[0] : null;
  const copyable = selected.size > 0 || chosen.some((r) => afterTime(actions, r.to) > byTime(actions, r.from));
  const edges = box && { from: x(box.from), to: x(box.to), low: y(box.low), high: y(box.high) };

  /** The indices of the points in `area`, but the regions' points, which are never selected. */
  const within = (area: Area) => {
    const found = [];
    for (let i = byTime(actions, area.from); i < actions.length && actions[i].at <= area.to; i++) {
      if (actions[i].pos >= area.low && actions[i].pos <= area.high && !regionAt(regions, actions[i].at)) found.push(i);
    }
    return found;
  };

  /** The regions whose whole time is in `area`'s, at any depth. */
  const regionsIn = (area: Area) => regions.filter((r) => r.from >= area.from && r.to <= area.to);

  const selectIn = (area: Area, base: { points: Iterable<number>; regions: Region[] } = { points: [], regions: [] }) => {
    setBox(area);
    select([...base.points, ...within(area)], [...base.regions, ...regionsIn(area)]);
  };

  const boxed = (area: Area) => (selectByTime ? { ...area, low: 0, high: 100 } : area);

  const boxAround = (ps: Action[], rs: Region[]): Area => {
    const area = ps.length ? ps.reduce(extended, spanned(ps[0], ps[0])) : { from: Infinity, to: -Infinity, low: 0, high: 100 };
    return { ...area, from: Math.min(area.from, ...rs.map((r) => r.from)), to: Math.max(area.to, ...rs.map((r) => r.to)) };
  };

  const boxSelect = (e: PointerEvent<SVGSVGElement>, click = () => select([])) => {
    e.preventDefault();
    const svg = e.currentTarget;
    const keep = boxMode;
    const base = keep ? undefined : { points: selected, regions: chosen };
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
      if (!moved) click();
    });
  };

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

  const picked = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, from: number, to: number, toggle: () => void) => {
    const last = anchor.current ?? { from, to };
    if (!e.shiftKey) anchor.current = { from, to };
    if (e.shiftKey) {
      const area = { from: Math.min(last.from, from), to: Math.max(last.to, to), low: 0, high: 100 };
      select(within(area), regionsIn(area));
    } else if (e.ctrlKey || e.metaKey) toggle();
    else return false;
    return true;
  };

  const toggleBoxMode = () => {
    if (placing) return;
    setBoxMode(!boxMode);
    if (!boxMode && (selected.size || chosen.length)) selectIn(boxed(boxAround([...selected].map((i) => actions[i]), chosen)));
    else setBox(null);
  };

  return { selected, setSelected, regionsOn, setRegionsOn, select, chosen, region, copyable, boxMode, selectByTime, setSelectByTime, box, setBox, edges, selectIn, boxed, boxAround, boxSelect, editBox, picked, toggleBoxMode };
}
