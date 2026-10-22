import { useEffect, useMemo, useRef, useState, type Dispatch, type PointerEvent, type SetStateAction } from "react";
import { usePersistedState } from "../hooks/usePersistedState";
import { clamp, points, type Action } from "../funscript/model";
import type { Bookmark } from "../funscript/markers";
import { afterTime, byTime, isInstance, isRepeat, regionAt, spanned, typed, type Area, type Inner, type Instance, type Region, type Script } from "./model";
import { fastestOf, gridParams, scaled, scaleParams, shifted, shiftParams, speedLimited, type GridFields } from "./transforms";
import { funcAt, GENERATE_DEFAULTS, generated, KNOT_GAP, ownScale, RANGED, rangeFields, rangeParams, REPEAT_DEFAULTS, repeated, repeatParams, SPANNED, splineAt, TOOLS, type Func, type FuncKey, type GenerateSetup, type GenPart, type Knots, type RepeatSetup, type ToolKind } from "./generate";
import { UNDO_SIZE } from "./history";
import { PAD, type Viewport } from "./viewport";

/** Least and first height of the view of Generate's Interval or Speed below the graph, in px. */
export const TIMING_HEIGHT = 80;

/** The advanced editor's tools, Scale, Shift depth, Max speed, Generate, Repeat, Invert and Grid: the open tool, its fields and its own undo history, its result, and the drags of its handles. */
export interface Tools {
  /**
   * The advanced editor's open tool, with the points and affected indices it
   * was opened on, and their fastest segment; its result shows until applied.
   * Generate on a `region`, in the main script too, edits it in place.
   */
  tool: { kind: ToolKind; actions: Action[]; picked: number[]; fastest: number | null; region?: Inner } | null;
  setTool: Dispatch<SetStateAction<Tools["tool"]>>;
  /** The grid tool is open; unlike the other tools, editing goes on, points added, dragged and placed snapping to it. */
  gridOpen: boolean;
  setGridOpen: Dispatch<SetStateAction<boolean>>;
  gridFields: GridFields;
  setGridFields: Dispatch<SetStateAction<GridFields>>;
  /** The grid, while its tool is open in the advanced editor and no other tool is. */
  grid: ReturnType<typeof gridParams> | null;
  /** `at` on the nearest of the grid's times, counted from the time shown as 0; as it is without them. */
  gridAt(at: number): number;
  /** `pos` on the nearest of the grid's depths; as it is without any. */
  gridPos(pos: number): number;
  /** The fields of the advanced editor's Scale, in %, as typed. */
  scale: { time: string; out: string; in: string };
  setScale: Dispatch<SetStateAction<Tools["scale"]>>;
  /** The fields of the advanced editor's Shift depth, as typed, in depth. */
  shift: { offset: string; out: string; in: string };
  setShift: Dispatch<SetStateAction<Tools["shift"]>>;
  /** The field of the advanced editor's Max speed, as typed. */
  maxSpeed: string;
  setMaxSpeed: Dispatch<SetStateAction<string>>;
  /** Which end Max speed keeps: In only moves points deeper, keeping the In reversals; Out only moves them out. */
  speedAnchor: "in" | "out";
  setSpeedAnchor: Dispatch<SetStateAction<"in" | "out">>;
  /** Generate's setup as shown and changed: the edited region's, or the remembered one. */
  genSetup: GenerateSetup;
  setGenSetup: Dispatch<SetStateAction<GenerateSetup>>;
  /** Generate shows its Interval or Speed in a view of its own below the graph. */
  timingView: boolean;
  setTimingView: Dispatch<SetStateAction<boolean>>;
  /** The timing view's height while its function is edited, in px, its top dragged then. */
  timingTall: number;
  setTimingTall: Dispatch<SetStateAction<number>>;
  /** Generate's range box fields, as typed: From and To in seconds as shown, Out and In in depth. */
  genRange: { from: string; to: string; out: string; in: string };
  setGenRange: Dispatch<SetStateAction<Tools["genRange"]>>;
  /** The part of Generate's or Repeat's setup shown, whose handles the graph shows; Generate's Layout, Repeat's Pattern, on opening. */
  genPart: GenPart;
  setGenPart: Dispatch<SetStateAction<GenPart>>;
  /** The timing view's height as shown, its first while another part is edited. */
  timingHeight: number;
  /** Repeat's setup as shown and changed: the edited region's, or the remembered one. */
  repSetup: RepeatSetup;
  setRepSetup: Dispatch<SetStateAction<RepeatSetup>>;
  /** Repeat's pattern: its box's start, in ms, its points, edited while it is open, in the script's times, and the box's fields as typed: Length in s, Out and In in depth. */
  repBox: { from: number; pattern: Action[]; length: string; out: string; in: string };
  setRepBox: Dispatch<SetStateAction<Tools["repBox"]>>;
  /** Whether the open tool's own undo history has a change to redo. */
  canRedo: boolean;
  /** Undo the open tool's last change; past its start, discard it. */
  undo(): void;
  /** Redo the open tool's next change. */
  redo(): void;
  /** Open a tool on the selected points, or all but the regions', from their defaults. */
  openTool(kind: ToolKind): void;
  /** Edit the region `r` in place: Generate or Repeat on its own setup and box; not while placing. */
  editRegion(r: Region): void;
  /** Repeat's box fields as numbers while it is open; null while one is refused. */
  repParams: ReturnType<typeof repeatParams>;
  /** Repeat's copies, their starts and end, while it is open; null while its box or Count is refused. */
  repRun: ReturnType<typeof repeated>;
  /** The open tool's result, from the points it was opened on, as its fields stand; null while one is invalid. */
  preview: { actions: Action[]; selected: Set<number>; regions?: Region[] } | null;
  /** The open tool's affected points as it was opened on them: the first's time `t0`, the last's `t1`, their lowest depth `lo` and highest `hi`; null without any. */
  toolSpan: { t0: number; t1: number; lo: number; hi: number } | null;
  /** Scale's box while it is open: the result's bounding box; null while a field is refused. */
  scaleBox: (NonNullable<ReturnType<typeof scaleParams>> & NonNullable<Tools["toolSpan"]> & { to: number }) | null;
  /** Shift depth's fields while it is open; null while one is refused. */
  shiftBox: ReturnType<typeof shiftParams>;
  /** Generate's range box while it is open; null while a field is refused. */
  genBox: Area | null;
  /** The box the open tool's functions run across: Generate's, or Repeat's copies' time over its pattern box's depths. */
  fnBox: Area | null;
  /** The open tool's functions, Generate's or Repeat's, as shown, and a change to one of them. */
  fnSetup: Partial<Record<FuncKey, Func>>;
  setFunc(key: FuncKey, f: (func: Func) => Func): void;
  /** The open tool's timing function, shown in its own view below the graph: Generate's Interval or Speed, none with Markers timing, or Repeat's Time. */
  timingKey: FuncKey | null;
  /** Where `u` % of a function's range is, in ms, across the box. */
  rangeTime(u: number): number;
  /** Why the open tool's result, though shown, cannot be applied: it would put points into a region or stretch one. */
  toolBlocked: string | null;
  /** Whether Generate's box holds a bookmark, so Markers timing can be chosen. */
  genMarked: boolean;
  /** The timing function shows in its own view below the graph. */
  timingShown: boolean;
  /** The function `key`'s curve across its box, as polyline points, `at` placing its values; none while a field is refused. */
  genCurve(key: FuncKey, at: (v: number) => number): string;
  /** The timing view's scale, bottom and top: a spline's Min and Max, else 0 to a quarter above the highest of the function's fields, so it stays put while dragging. */
  timingLow: number;
  timingHigh: number;
  /** Where a value of Generate's Interval or Speed goes in the timing view, in px. */
  timingY(v: number): number;
  /**
   * Drag one of a tool's handles in the graph; `move` gets how far the pointer
   * has gone in time and depth since the press, the depth in whole steps and
   * past the graph's top and bottom too; in a view where 100 spans `height` px.
   */
  dragHandle(e: PointerEvent<SVGElement>, move: (dt: number, dp: number) => void, height?: number): void;
  /** Drag Scale's box by `sides`: its right edge sets Time %, its top and bottom Out and In, which may pass each other; its body both, within 0–100. */
  dragScale(e: PointerEvent<SVGRectElement>, sides: ("to" | "low" | "high")[]): void;
  /** Drag Shift depth's `side`, a position's: the box sets Offset, −100–100; Out and In stay within 0–100 and stop at each other. */
  dragShift(e: PointerEvent<SVGRectElement>, side: "offset" | "min" | "max"): void;
  /** Drag the `sides` of Generate's box, as the selection box's: an edge or corner resizes it, all four move it; from 0 on and within 0–100. */
  dragGenerate(e: PointerEvent<SVGRectElement>, sides: (keyof Area)[]): void;
  /** Drag the `sides` of Repeat's pattern box: its right edge sets Length, from 1 ms; its top and bottom its depths, within 0–100, which may pass each other. */
  dragRepeat(e: PointerEvent<SVGRectElement>, sides: ("to" | "low" | "high")[]): void;
  /**
   * Drag point `i` of Repeat's pattern `pattern`: in time between its
   * neighbours and within the box, in depth within 0–100. Pressed twice in a
   * row, it goes instead, while the pattern keeps two.
   */
  dragPattern(e: PointerEvent<SVGElement>, i: number, pattern?: Action[]): void;
  /** Add a point to Repeat's pattern under the pointer, in its box's time, and drag it. */
  addPattern(e: PointerEvent<SVGRectElement>): void;
  /**
   * Drag knot `i` of `knots`, the spline `key`'s: in value within 0–100 (%),
   * in the box or, for Interval, Speed and Time, the timing view; in time
   * between its neighbours, the end knots only in value.
   * Pressed twice in a row, it goes instead, unless it is an end.
   */
  dragKnot(e: PointerEvent<SVGElement>, key: FuncKey, knots: Knots, i: number): void;
  /** Add a knot to the spline `key` where its line is under the pointer, and drag it. */
  addKnot(e: PointerEvent<SVGElement>, key: FuncKey): void;
  /**
   * Apply the open tool's result as one edit, unless it leaves the points as
   * they are, and go back to the tools. Generate's box becomes a region of its
   * points, with its own copy of the setup, and selected; not a box without
   * length, whose point stays ordinary. Repeat's copies become a region too,
   * with its pattern. Editing a region, it takes the old one's place.
   */
  applyTool(): void;
  /** Invert the selected points' depths, or all but the regions', at once as one edit, without opening a tool; not when it leaves them as they are. */
  invert(): void;
}

/**
 * The advanced editor's tools on `actions`, `regions` and `bookmarks`, times
 * shown from `zero`: on the `selected` points, or `view`'s time, its result
 * applied as an `edit` that `select`s or `setSelected`s it; opening one
 * drops the selection box with `setBox`, not while `placing`. Its handles'
 * drags follow the `viewport` as one `setDragging` drag, after which its
 * undo history takes a step. Editing an instance region is `onEditInstance`.
 * The grid only in the `advanced` editor.
 */
export function useTool({ actions, regions, bookmarks, zero, selected, view, viewport, advanced, placing, edit, select, setSelected, setBox, dragging, setDragging, onEditInstance }: {
  actions: Action[];
  regions: Region[];
  bookmarks: Bookmark[];
  zero: number;
  selected: Set<number>;
  view: { from: number; span: number };
  viewport: Viewport;
  advanced: boolean;
  placing: boolean;
  edit: (label: string, next: SetStateAction<Script>) => void;
  select: (ps: Iterable<number>, rs?: Iterable<Region>) => void;
  setSelected: (selected: Set<number>) => void;
  setBox: (area: Area | null) => void;
  dragging: boolean;
  setDragging: (dragging: boolean) => void;
  onEditInstance: (instance: Instance) => void;
}): Tools {
  const { width, plotHeight, x, pointerAt, track } = viewport;
  const [tool, setTool] = useState<Tools["tool"]>(null);
  const [gridOpen, setGridOpen] = useState(false);
  const [gridFields, setGridFields] = usePersistedState<GridFields>("ossm:editorGrid", { time: "1", depth: "10", depths: "" }, localStorage);
  const grid = advanced && gridOpen && !tool ? gridParams(gridFields) : null;
  const gridAt = (at: number) => (grid?.step ? zero + Math.round((at - zero) / grid.step) * grid.step : at);
  const gridPos = (pos: number) => (grid?.positions.length ? grid.positions.reduce((a, b) => (Math.abs(b - pos) < Math.abs(a - pos) ? b : a)) : pos);
  const [scale, setScale] = useState({ time: "100", out: "0", in: "100" });
  const [shift, setShift] = useState({ offset: "0", out: "0", in: "100" });
  const [maxSpeed, setMaxSpeed] = useState("");
  const [speedAnchor, setSpeedAnchor] = usePersistedState<"in" | "out">("ossm:editorSpeedAnchor", "in", localStorage);
  /** Generate's setup for new runs, remembered unlike the other tools' fields. */
  const [remembered, setRemembered] = usePersistedState<GenerateSetup>("ossm:editorGenerate", GENERATE_DEFAULTS, localStorage);
  /** The setup of the region being edited, its own; the remembered one stays as it is. */
  const [regionSetup, setRegionSetup] = useState(GENERATE_DEFAULTS);
  const [genSetup, setGenSetup] = tool?.region ? [regionSetup, setRegionSetup] : [remembered, setRemembered];
  const [timingView, setTimingView] = usePersistedState("ossm:editorTimingView", true, localStorage);
  const [timingTall, setTimingTall] = usePersistedState("ossm:editorTimingHeight", TIMING_HEIGHT, localStorage);
  const [genRange, setGenRange] = useState({ from: "0", to: "0", out: "0", in: "100" });
  const [genPart, setGenPart] = useState<GenPart>("position");
  const timingHeight = genPart === "timing" ? timingTall : TIMING_HEIGHT;
  /** Repeat's setup for new runs, remembered as Generate's; a region's own while editing it. */
  const [rememberedRepeat, setRememberedRepeat] = usePersistedState<RepeatSetup>("ossm:editorRepeat", REPEAT_DEFAULTS, localStorage);
  const [regionRepeat, setRegionRepeat] = useState(REPEAT_DEFAULTS);
  const [repSetup, setRepSetup] = tool?.region ? [regionRepeat, setRegionRepeat] : [rememberedRepeat, setRememberedRepeat];
  const [repBox, setRepBox] = useState({ from: 0, pattern: [] as Action[], length: "1", out: "0", in: "100" });
  /** The tools' fields and setups, as the open tool's undo history keeps them. */
  const toolFields = { scale, shift, maxSpeed, speedAnchor, genSetup, genRange, repSetup, repBox };
  /** The open tool's own undo history: its fields after each change, a drag's once it ends; it starts anew with each tool opened. */
  const [toolSteps, setToolSteps] = useState<{ tool: typeof tool; states: (typeof toolFields)[]; index: number }>({ tool: null, states: [], index: 0 });
  useEffect(() => {
    if (dragging || !tool) return;
    setToolSteps((h) => {
      if (h.tool !== tool) return { tool, states: [toolFields], index: 0 };
      const now = h.states[h.index];
      if ((Object.keys(now) as (keyof typeof now)[]).every((k) => now[k] === toolFields[k])) return h;
      const states = [...h.states.slice(0, h.index + 1), toolFields].slice(-UNDO_SIZE - 1);
      return { tool, states, index: states.length - 1 };
    });
  }, [tool, dragging, scale, shift, maxSpeed, speedAnchor, genSetup, genRange, repSetup, repBox]);
  /** Go to the open tool's fields after change `index` of its undo history. */
  const toolJump = (index: number) => {
    const f = toolSteps.states[index];
    setToolSteps((h) => ({ ...h, index }));
    setScale(f.scale);
    setShift(f.shift);
    setMaxSpeed(f.maxSpeed);
    setSpeedAnchor(f.speedAnchor);
    setGenSetup(f.genSetup);
    setGenRange(f.genRange);
    setRepSetup(f.repSetup);
    setRepBox(f.repBox);
  };
  // With a tool open, undo and redo go through its own history; undo past its start discards it.
  const canRedo = toolSteps.index < toolSteps.states.length - 1;
  const undo = () => (toolSteps.index > 0 ? toolJump(toolSteps.index - 1) : setTool(null));
  const redo = () => toolJump(toolSteps.index + 1);

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

  const editRegion = (r: Region) => {
    if (placing) return;
    if (isInstance(r)) return onEditInstance(r);
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

  const repParams = tool?.kind === "repeat" ? repeatParams(repBox) : null;
  const repRun = useMemo(() => repParams && repeated(repSetup, repBox.from, repBox.pattern, repParams.length, repParams.bottom, repParams.top), [repSetup, repBox, tool]);

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

  const toolSpan = useMemo(() => {
    if (!tool?.picked.length) return null;
    const { actions, picked } = tool;
    const depths = picked.map((i) => actions[i].pos);
    return { t0: actions[picked[0]].at, t1: actions[picked[picked.length - 1]].at, lo: Math.min(...depths), hi: Math.max(...depths) };
  }, [tool]);
  const scaleBox = (() => {
    const params = tool?.kind === "scale" && toolSpan && scaleParams(scale);
    return params ? { ...params, ...toolSpan!, to: toolSpan!.t0 + ((toolSpan!.t1 - toolSpan!.t0) * params.time) / 100 } : null;
  })();
  const shiftBox = tool?.kind === "shift" ? shiftParams(shift) : null;
  const genBox = tool?.kind === "generate" ? rangeParams(genRange, zero) : null;
  const fnBox = genBox ?? (repRun && repParams && { from: repBox.from, to: repRun.end, low: repParams.bottom, high: repParams.top });
  const fnSetup: Partial<Record<FuncKey, Func>> = tool?.kind === "repeat" ? repSetup : genSetup;
  const setFunc = (key: FuncKey, f: (func: Func) => Func) => (tool?.kind === "repeat"
    ? setRepSetup((s) => ({ ...s, [key]: f(s[key as "time"]) }))
    : setGenSetup((s) => ({ ...s, [key]: f(s[key as "interval"]) })));
  const timingKey: FuncKey | null = tool?.kind === "repeat" ? "time" : tool?.kind === "generate" && genSetup.timing !== "markers" ? genSetup.timing : null;
  /** Where `u` % of a function's range is, in ms, across the box, and back. */
  const rangeTime = (u: number) => fnBox!.from + (u / 100) * (fnBox!.to - fnBox!.from);
  const rangeU = (t: number) => (fnBox!.to > fnBox!.from ? ((t - fnBox!.from) / (fnBox!.to - fnBox!.from)) * 100 : 0);
  /** A function's value at `t` ms, a ramp's or spline's along its range, the rest from the box's start. */
  const valueAt = (key: FuncKey, t: number) => {
    const func = fnSetup[key]!;
    return RANGED.includes(func.shape) ? funcAt(func, rangeU(t), 100) : funcAt(func, t - fnBox!.from, fnBox!.to - fnBox!.from);
  };
  const toolBlocked = genBox && regions.some((r) => r !== tool!.region && r.from <= genBox.to && r.to >= genBox.from) ? "The box overlaps a region"
    : genBox && tool!.region && genBox.to <= genBox.from ? "A region's box needs a length"
    : repRun && regions.some((r) => r !== tool!.region && r.from <= repRun.end && r.to >= repBox.from) ? "The copies overlap a region"
    : repRun && repRun.end <= repBox.from ? "The copies need a length"
    : scaleBox && scaleBox.time !== 100 && regions.some((r) => r.from > scaleBox.t0 && r.to < scaleBox.t1) ? "Time cannot be scaled across a region"
    : null;
  const genMarked = !!genBox && bookmarks.some((b) => b.time >= genBox.from && b.time <= genBox.to);
  const timingShown = !!fnBox && timingView && !!timingKey;

  /** Times every 2 px across the functions' box's part in view, where they are drawn. */
  const genTimes = (() => {
    if (!fnBox || !(width > 0)) return [];
    const [t0, t1, step] = [Math.max(fnBox.from, view.from), Math.min(fnBox.to, view.from + view.span), (2 / width) * view.span];
    return t1 < t0 ? [] : Array.from({ length: Math.ceil((t1 - t0) / step) + 1 }, (_, i) => Math.min(t0 + i * step, t1));
  })();
  const genCurve = (key: FuncKey, at: (v: number) => number) => {
    const values = genTimes.map((t) => valueAt(key, t));
    return values.some(Number.isNaN) ? "" : genTimes.map((t, i) => `${x(t)},${at(values[i])}`).join(" ");
  };
  const [timingLow, timingHigh] = (() => {
    if (!timingKey) return [0, 1];
    const func = fnSetup[timingKey]!;
    if (func.shape === "spline") return [typed(func.min ?? ""), typed(func.max ?? "")];
    const peak = Math.max(...SPANNED.map((f) => typed(func[f] ?? "")).filter(Number.isFinite));
    return [0, peak > 0 ? peak * 1.25 : 1];
  })();
  const timingY = (v: number) => PAD + (1 - clamp((v - timingLow) / (timingHigh - timingLow), 0, 1)) * (timingHeight - 2 * PAD);

  const dragHandle = (e: PointerEvent<SVGElement>, move: (dt: number, dp: number) => void, height = plotHeight - 2 * PAD) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const [origin, y0] = [pointerAt(e).at, e.clientY];
    // One change in the tool's undo history.
    setDragging(true);
    track(e.currentTarget.ownerSVGElement!, e, (m) => move(pointerAt(m).at - origin, Math.round(((y0 - m.clientY) / height) * 100)), () => setDragging(false));
  };

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

  const dragShift = (e: PointerEvent<SVGRectElement>, side: "offset" | "min" | "max") => {
    const { offset, min, max } = shiftBox!;
    dragHandle(e, (_, dp) => {
      const value = side === "offset" ? clamp(Math.round(offset + dp), -100, 100) : side === "min" ? clamp(min + dp, 0, max) : clamp(max + dp, min, 100);
      setShift((f) => ({ ...f, ...(side === "offset" ? { offset: String(-value) } : side === "min" ? { in: String(100 - value) } : { out: String(100 - value) }) }));
    });
  };

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

  const applyTool = () => {
    const { kind, picked, region } = tool!;
    const next = preview!;
    setTool(null);
    // Repeat's pattern, the points in its box, timed from its start.
    const pattern = repBox.pattern.filter((a) => a.at <= repBox.from + (repParams?.length ?? 0)).map((a) => ({ at: a.at - repBox.from, pos: a.pos }));
    const built: Inner | null = kind === "generate" && genBox!.to > genBox!.from ? { ...genBox!, generate: structuredClone(genSetup) }
      : kind === "repeat" ? { from: repBox.from, to: repRun!.end, repeat: { ...structuredClone(repSetup), pattern, length: repParams!.length, bottom: repParams!.bottom, top: repParams!.top } }
      : null;
    // Editing a region keeps its name.
    const made = built && region?.name ? { ...built, name: region.name } : built;
    const same = next.actions.length === actions.length && next.actions.every((a, i) => a.at === actions[i].at && a.pos === actions[i].pos);
    if (same && (!made || JSON.stringify(made) === JSON.stringify(region))) return;
    const label = region ? "Edit region"
      : kind === "repeat" ? `Repeat ${points(pattern.length)} ×${repSetup.count}`
      : `${TOOLS.find((t) => t.kind === kind)!.verb} ${points(kind === "generate" ? next.selected.size : picked.length)}`;
    edit(label, (s) => ({ ...s, actions: next.actions, regions: made ? [...(next.regions ?? s.regions), made].sort((a, b) => a.from - b.from) : next.regions ?? s.regions }));
    if (made) select([], [made]);
    else setSelected(next.selected);
  };

  const invert = () => {
    const picked = selected.size ? [...selected] : [...actions.keys()].filter((i) => !regionAt(regions, actions[i].at));
    if (picked.every((i) => actions[i].pos === 50)) return;
    const hit = new Set(picked);
    edit(`Invert ${points(picked.length)}`, (s) => ({ ...s, actions: s.actions.map((a, i) => (hit.has(i) ? { at: a.at, pos: 100 - a.pos } : a)) }));
    setSelected(hit);
  };

  return {
    tool, setTool, gridOpen, setGridOpen, gridFields, setGridFields, grid, gridAt, gridPos, scale, setScale, shift, setShift, maxSpeed, setMaxSpeed,
    speedAnchor, setSpeedAnchor, genSetup, setGenSetup, timingView, setTimingView, timingTall, setTimingTall, genRange, setGenRange, genPart, setGenPart,
    timingHeight, repSetup, setRepSetup, repBox, setRepBox, canRedo, undo, redo, openTool, editRegion, repParams, repRun, preview, toolSpan, scaleBox,
    shiftBox, genBox, fnBox, fnSetup, setFunc, timingKey, rangeTime, toolBlocked, genMarked, timingShown, genCurve, timingLow, timingHigh, timingY,
    dragHandle, dragScale, dragShift, dragGenerate, dragRepeat, dragPattern, addPattern, dragKnot, addKnot, applyTool, invert,
  };
}
