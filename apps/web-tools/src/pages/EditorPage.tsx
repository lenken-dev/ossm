import { useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { AlertDialog, Box, Button, Callout, Flex, Heading, IconButton, SegmentedControl, Separator, Slider, Switch, Text, TextField } from "@radix-ui/themes";
import { ClipboardIcon, MixerHorizontalIcon, CopyIcon, ResetIcon, DoubleArrowDownIcon, DoubleArrowLeftIcon, DoubleArrowRightIcon, DoubleArrowUpIcon, Cross2Icon, DownloadIcon, ExclamationTriangleIcon, FileIcon, HeightIcon, PlayIcon, ScissorsIcon, UploadIcon, VideoIcon, ViewVerticalIcon } from "@radix-ui/react-icons";
import { bisectLeft, bisectRight } from "d3";
import { usePersistedState } from "../hooks/usePersistedState";
import { useWindowEvent } from "../hooks/useWindowEvent";
import { PLAYER_WINDOW, SENT_SCRIPT_KEY, readFunscript } from "../funscript/file";
import { formatScriptTime, formatTimeTick, timeTicks } from "../funscript/time";
import { LabeledSlider } from "../widgets";
import { clamp, LINE_COLOR, stats, type Action } from "../funscript/model";
import { lightChapters, markerColor, readMarkers, writeMarkers, type Marker } from "../funscript/markers";
import { SectionHeader, Stats } from "../funscript/widgets";
import { NamePopover, SnippetIcon } from "../editor/NamePopover";
import { afterTime, bandOf, byTime, clipBy, EMPTY, extended, generators, instanceOf, isInstance, items, markersRegions, movedBy, regionAt, regionName, regionNoun, sameContent, spanned, toggled, type Advanced, type Clip, type Content, type Instance, type Placing, type Region, type Script } from "../editor/model";
import { rangeFields, refilled, withBookmarks } from "../editor/generate";
import { download, readClip, readRegions } from "../editor/file";
import { changedSpan, HISTORY_SIZE, startedAt, UNDO_SIZE, withLibraryChanges, type Timeline } from "../editor/history";
import { AXIS, FOLLOW_AT, useViewport } from "../editor/viewport";
import { MediaPlayer, useMediaPlayer } from "../editor/MediaPlayer";
import { useMarkers } from "../editor/useMarkers";
import { useTool } from "../editor/useTool";
import { useLibrary } from "../editor/useLibrary";
import { usePlacing } from "../editor/usePlacing";
import { useSelection } from "../editor/useSelection";
import { GRIP, GRIPS, TimingView, TOOL_BOX, ToolHandles } from "../editor/ToolHandles";
import { ToolPanel } from "../editor/ToolPanel";
import { LANE_HEIGHT, MarkerLane } from "../editor/MarkerLane";
import { MarkersPanel } from "../editor/MarkersPanel";
import { SnippetsPanel } from "../editor/SnippetsPanel";
import { Minimap } from "../funscript/Minimap";
import { GraphCanvas } from "../editor/GraphCanvas";
import { SpeedCalculator } from "../funscript/SpeedCalculator";
import { RegionPanel } from "../editor/RegionPanel";
import { ClipboardHistory, UndoHistory } from "../editor/HistoryPopovers";
import { GraphLayout } from "./GraphPage";

/** Size of the buttons in the selection box that extend it, in px. */
const EXTEND = 24;

/** Visible time range, in ms; at most the script (the main one too, in the advanced editor), Generate's box or the video, whichever is longer, but at least the floor, room to generate into a blank script. */
const MIN_SPAN = 500;
const MAX_SPAN_FLOOR = 120_000;
/** Steps of the visible time slider, in s; the first that keeps it to about this many steps is used. */
const SPAN_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60];
const SPAN_STEP_COUNT = 240;

export default function EditorPage() {
  // Kept across reloads, so switching tabs or closing the page does not lose the work.
  const [main, setMain] = usePersistedState<Script>("ossm:editorScript", EMPTY, localStorage);
  /** The advanced editor's document while it is open; kept across reloads too. */
  const [advanced, setAdvanced] = usePersistedState<Advanced | null>("ossm:editorAdvanced", null, localStorage);
  /** The main script for the advanced editor's edits, which callbacks from before its last change make too, as a bookmark's name field. */
  const mainRef = useRef(main);
  mainRef.current = main;
  /**
   * The script the page shows and edits: the main one, or with the advanced
   * editor's points and regions while it is open; its marker changes, with
   * the lane unlocked, go to the main script, whose Markers regions follow.
   */
  const script = advanced ? { ...main, actions: advanced.actions, regions: advanced.regions } : main;
  const setScript: typeof setMain = (next) => {
    if (!advanced) return setMain(next);
    setAdvanced((d) => {
      if (!d) return d;
      const m = mainRef.current;
      const { actions, regions, chapters, bookmarks } = next instanceof Function ? next({ ...m, actions: d.actions, regions: d.regions }) : next;
      // Run twice in strict mode, which gives the same main script.
      if (chapters !== m.chapters || bookmarks !== m.bookmarks) setMain((s) => withBookmarks({ ...s, chapters }, bookmarks));
      return { ...d, actions, regions };
    });
  };
  /** The Snippets panel shows beside the graph, in the main script and the advanced editor alike. */
  /** The panel beside the graph, on its other side from the sidebar, and which it shows: the markers list or the snippet library. */
  const [asideShown, setAsideShown] = usePersistedState("ossm:editorAsideShown", true, localStorage);
  const [asideTab, setAsideTab] = usePersistedState<"markers" | "snippets">("ossm:editorAsideTab", "snippets", localStorage);
  /** What the next edit is called in the undo history. */
  const editLabel = useRef<string | null>(null);
  const [view, setView] = usePersistedState("ossm:editorView", { from: 0, span: 10_000 });
  /** The view for drags, which read it between renders as they scroll it. */
  const viewRef = useRef(view);
  viewRef.current = view;
  /** The points for drags, which read them between renders. */
  const actionsRef = useRef(script.actions);
  actionsRef.current = script.actions;
  const [error, setError] = useState<string | null>(null);
  /** The time under the pointer over the graph or the marker lane, where B adds a bookmark without media. */
  const hoverAt = useRef<number | null>(null);
  /** Asking whether to apply or discard the advanced editor's changes, on leaving it by its toolbox button. */
  const [leaving, setLeaving] = useState(false);
  /**
   * Points being placed, timed from the first, with the regions they carry,
   * following the pointer until a click or a drag's release places them; with
   * the `picked` ones of them, the selection being moved, which alone take the
   * depth change and are selected once placed (all without), what the edit
   * is called and, moved or added, the time its first point came from.
   */
  const [placing, setPlacing] = useState<Placing | null>(null);
  /** While a selection that is not consecutive is dragged in place, the points as they were, which of them move, its regions as they were, drawn dashed, and the point dragged by, else the first, as it was and, once moved, as it is `now`. */
  const [apart, setApart] = useState<{ actions: Action[]; moving: Set<number>; regions: Region[]; grip?: Action; now?: Action } | null>(null);
  /** While one is dragged, puts it back where it was, for Escape. */
  const cancelApart = useRef<(() => void) | null>(null);
  /** The latest copies, newest first; for this visit to the page. */
  const [history, setHistory] = useState<Clip[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** The graph and the marker lane, which scroll and zoom alike. */
  const timeRef = useRef<HTMLDivElement>(null);
  const viewport = useViewport(boxRef, viewRef, setView);
  const { width, height, plotHeight, x, y, pointerAt, track } = viewport;
  const media = useMediaPlayer(setView);
  /** A minimap of the whole script to scroll with, instead of the slider. */
  const [minimap, setMinimap] = usePersistedState("ossm:editorMinimap", true, localStorage);
  /** The sidebar's stats are expanded, else just their header. */
  const [statsShown, setStatsShown] = usePersistedState("ossm:editorStatsShown", true, localStorage);
  const [calcShown, setCalcShown] = usePersistedState("ossm:editorCalcShown", false, localStorage);
  /** The advanced editor shows times from its 0, earlier ones negative; only as shown, the points keep the main script's times. */
  const [fromZero, setFromZero] = usePersistedState("ossm:editorFromZero", false, localStorage);
  /** The advanced editor's marker lane and Markers panel take presses, and B adds a bookmark, editing the main script's markers. */
  const [markersUnlocked, setMarkersUnlocked] = usePersistedState("ossm:editorMarkersUnlocked", false, localStorage);
  const markersLocked = !!advanced && !markersUnlocked;
  /** In the advanced editor, points are added and dragged onto the nearest bookmark's time; only with bookmarks. */
  const [onMarkers, setOnMarkers] = usePersistedState("ossm:editorOnMarkers", false, localStorage);
  useEffect(() => {
    if (!script.bookmarks.length) setOnMarkers(false);
  }, [script.bookmarks.length, setOnMarkers]);
  /** The time shown as 0. */
  const zero = advanced && fromZero ? advanced.zero : 0;
  const end = script.actions.length ? script.actions[script.actions.length - 1].at : 0;

  // While the video plays, the playhead moves every frame and the graph follows it.
  useEffect(() => {
    if (media.paused) return;
    let frame = requestAnimationFrame(function tick() {
      const t = (media.videoRef.current?.currentTime ?? 0) * 1000;
      media.setTime(t);
      setView((v) => ({ ...v, from: Math.max(t - v.span * FOLLOW_AT, 0) }));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [media.paused, setView]);

  const { actions, chapters, bookmarks, regions } = script;
  const { selected, setSelected, regionsOn, setRegionsOn, select, chosen, region, copyable, boxMode, selectByTime, setSelectByTime, box, setBox, edges, selectIn, boxed, boxAround, boxSelect, editBox, picked, toggleBoxMode } = useSelection({ actions, regions, viewport, placing: !!placing });
  /** While the advanced editor is open, the main script's other points, in runs broken where its points were taken out; drawn faintly behind them, never edited. */
  const context = useMemo(() => {
    if (!advanced) return [];
    const from = new Set(advanced.from);
    const runs: Action[][] = [[]];
    main.actions.forEach((a, i) => (from.has(i) ? runs[runs.length - 1].length && runs.push([]) : runs[runs.length - 1].push(a)));
    return runs.filter((run) => run.length);
  }, [main.actions, advanced?.from]);

  /** The main script's undo history, put aside while the advanced editor is open; lost on a reload, when it starts over. */
  const mainTimeline = useRef<Timeline | null>(null);
  /** Set while a drag runs, so the whole drag becomes one edit when it ends; undo and redo wait for it. */
  const [dragging, setDragging] = useState(false);
  /** Change the script as an edit called `label`; in a drag, the whole drag is one edit, called as its last step. */
  const edit = (label: string, next: Parameters<typeof setScript>[0]) => {
    editLabel.current = label;
    setScript(next);
  };
  const markers = useMarkers({ chapters, bookmarks, edit, setDragging, viewport, laneRef: timeRef, onSelect: () => {
    setSelected(new Set());
    setBox(null);
  } });
  useEffect(() => {
    if (selected.size || regionsOn.size) markers.setMarked(new Set());
  }, [selected, regionsOn]);
  useEffect(() => {
    if (markers.marked.size) setRegionsOn(new Set());
  }, [markers.marked]);
  const tools = useTool({ actions, regions, bookmarks, zero, selected, view, viewport, advanced: !!advanced, placing: !!placing, edit, select, setSelected, setBox, dragging, setDragging, onEditInstance: (instance) => openAdvanced(undefined, instance) });
  const { tool, setTool, gridOpen, setGridOpen, grid, gridAt, gridPos, setGenRange, timingHeight, repBox, editRegion, repParams, preview, genBox, fnBox, timingShown } = tools;
  const snippetLibrary = useLibrary({ advanced: !!advanced, tool: !!tool, editLabel, cancelPlacing: () => cancelPlacing(), setPlacing, setError });
  const { library, setLibraryFile, rowDrag, snippetFrom, nameTaken, saveSnippet } = snippetLibrary;
  /** Undo history: the points, markers, regions and snippet library after each edit, the first as loaded; `index` is the current one. */
  const [timeline, setTimeline] = useState(() => startedAt(script, library, advanced ? "Open" : "Start"));

  // Every change of the points, markers, regions or snippet library, except by undo and redo, is an edit.
  useEffect(() => {
    if (dragging) return;
    const label = editLabel.current ?? "Edit";
    editLabel.current = null;
    setTimeline((tl) => {
      const now = tl.states[tl.index];
      if (sameContent(now, script) && now.library === library) return tl;
      const states = [...tl.states.slice(0, tl.index + 1), { actions, chapters, bookmarks, regions, library, label }].slice(-UNDO_SIZE - 1);
      return { states, index: states.length - 1 };
    });
  }, [actions, chapters, bookmarks, regions, library, dragging]);

  // The selection goes with the current entry, to come back with it; not while dragging or placing, so an entry keeps the one from before them.
  useEffect(() => {
    if (dragging || placing) return;
    setTimeline((tl) => ({ ...tl, states: tl.states.map((st, k) => (k === tl.index ? { ...st, selection: { points: selected, regions: regionsOn, markers: markers.marked } } : st)) }));
  }, [selected, regionsOn, markers.marked, timeline.index, dragging, placing]);
  const placement = usePlacing({ script, view, viewport, selected, regionsOn, boxMode, onMarkers: !!advanced && onMarkers, gridAt, gridPos, preview, placing, setPlacing, edit, select, setBox, fitBox: (ps, rs, on) => setBox(boxed(boxAround(ps, rs)), on) });
  const { lifted, setLifted, placeAt, setPlaceAt, carrying, setSettle, held, setHeld, kept, carriedBy, carry, cancelPlacing, put, place, landedAt, ghost, landed, refused, shown, shownRegions, marks, outlined, astray, removed } = placement;

  /** Go to the content and snippet library after edit `index` of the undo history, with the selection last made there, in selection mode with the box around it, and bring the change into view. */
  const jump = (index: number) => {
    const step = timeline.states[index];
    const { actions, chapters, bookmarks, regions, library } = step;
    const { points, regions: rs, markers: ms } = step.selection ?? { points: new Set<number>(), regions: new Set<Region>(), markers: new Set<Marker>() };
    const span = changedSpan(script, step);
    setTimeline((tl) => ({ ...tl, index }));
    setTool(null);
    setScript((s) => ({ ...s, actions, chapters, bookmarks, regions }));
    setLibraryFile({ ossmRsWebTools: { version: 1, snippets: library } });
    setSelected(points);
    setRegionsOn(rs);
    markers.setMarked(ms);
    setBox(boxMode && (points.size || rs.size) ? boxed(boxAround([...points].map((i) => actions[i]), [...rs])) : null, actions);
    setPlacing(null);
    setLifted(null);
    if (span) setView((v) => (span.to < v.from || span.from > v.from + v.span ? { ...v, from: Math.max(span.from - v.span * FOLLOW_AT, 0) } : v));
  };
  /** The points and markers as last saved, opened or started anew; unknown after a reload with unsaved changes. */
  const [unsaved, setUnsaved] = usePersistedState("ossm:editorUnsaved", false, localStorage);
  const [saved, setSaved] = useState<Content | null>(() => (unsaved ? null : main));
  const changed = !saved || !sameContent(saved, main);
  useEffect(() => setUnsaved(changed), [changed, setUnsaved]);
  useWindowEvent("beforeunload", (e) => {
    if (changed) e.preventDefault();
  });
  /** Whether the script may be replaced, as Open and New do, starting its undo history anew but for the snippet library's changes: without unsaved changes, or once confirmed. */
  const discardable = () => !changed || confirm("Discard the unsaved changes?");
  /**
   * A press on the graph: on a point or a region's band, as `pointDown` and
   * `regionDown`; with Shift or in selection mode, a box selection; with more
   * than a point selected, it only clears the selection. Otherwise it adds a
   * point under the pointer: a paste of one, dragged until released.
   */
  const add = (e: PointerEvent<SVGSVGElement>) => {
    if (tool) return;
    const hit = pointUnder(e);
    if (hit !== null) return pointDown(e, hit);
    if (e.button !== 0) return;
    const point = pointerAt(e);
    const inside = regionAt(regions, point.at);
    if (boxMode || e.shiftKey) return boxSelect(e, inside && !boxMode ? () => regionDown(e, inside) : undefined);
    if (inside) return regionDown(e, inside);
    if (selected.size > 1 || chosen.length) return select([]);
    if (point.at < 0) return;
    setPlacing({ actions: [{ at: 0, pos: point.pos }], regions: [], label: "Add point", from: point.at });
    setPlaceAt(point);
    carry(e, point);
  };

  /**
   * A press on the point `i`: with Ctrl/Cmd or Shift, it is picked, or in
   * selection mode the box grows to take it in. A plain press selects the
   * point, or keeps the selection it is in, and drags that.
   */
  const pointDown = (e: PointerEvent<Element>, i: number) => {
    if (e.button !== 0 || tool) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (boxMode) return selectIn(boxed(extended(box ?? spanned(actions[i], actions[i]), actions[i])));
    }
    if (picked(e, actions[i].at, actions[i].at, () => setSelected(toggled(i)))) return;
    const [ps, rs] = selected.has(i) ? [[...selected], chosen] : [[i], []];
    select(ps, rs);
    if (consecutive(ps, rs)) carry(e, null, ps, rs, i);
    else dragApart(e, ps, rs, i);
  };

  /** A press on the region `r`'s band, as on a point. */
  const regionDown = (e: PointerEvent<SVGSVGElement>, r: Region) => {
    if (picked(e, r.from, r.to, () => setRegionsOn(toggled(r)))) return;
    const [ps, rs] = regionsOn.has(r) ? [[...selected], chosen] : [[], [r]];
    select(ps, rs);
    if (consecutive(ps, rs)) carry(e, null, ps, rs);
    else dragApart(e, ps, rs);
  };

  /** Whether the points `ps` and the regions `rs` are consecutive: no other point or region between the first and the last of them. */
  const consecutive = (ps: number[], rs: Region[]) => {
    const times = [...ps.map((i) => actions[i].at), ...rs.flatMap((r) => [r.from, r.to])];
    const [from, to] = [Math.min(...times), Math.max(...times)];
    const own = new Set(ps);
    for (let i = byTime(actions, from); i < afterTime(actions, to); i++) if (!own.has(i) && !regionAt(rs, actions[i].at)) return false;
    return regions.every((r) => rs.includes(r) || r.to < from || r.from > to);
  };

  /**
   * The points `ps` and the regions `rs` moved in place: how far in time,
   * each staying between the other points and regions either side of it,
   * from 0 on, and in depth, within 0 to 100; and `shifted`, which moves them
   * `dt` ms and the points `dp` in depth as one edit, selects them and
   * returns the points, the selected ones among them and the regions.
   */
  const inPlace = (ps: number[], rs: Region[]) => {
    const own = new Set(ps);
    const moving = new Set(actions.flatMap((a, i) => (own.has(i) || regionAt(rs, a.at) ? [i] : [])));
    // What stops them: the other points and the other regions' edges.
    const walls = [...actions.filter((_, i) => !moving.has(i)).map((a) => a.at), ...regions.filter((r) => !rs.includes(r)).flatMap((r) => [r.from, r.to])].sort((a, b) => a - b);
    let [dtMin, dtMax] = [-Infinity, Infinity];
    for (const [a, b] of [...ps.map((i) => [actions[i].at, actions[i].at]), ...rs.map((r) => [r.from, r.to])]) {
      const [before, after] = [walls[bisectLeft(walls, a) - 1], walls[bisectRight(walls, b)]];
      dtMin = Math.max(dtMin, -a, before === undefined ? -Infinity : before + 1 - a);
      dtMax = Math.min(dtMax, after === undefined ? Infinity : after - 1 - b);
    }
    const depths = ps.map((i) => actions[i].pos);
    const shifted = (dt: number, dp: number) => {
      const moved = rs.map((r) => movedBy(r, dt));
      const points = actions.map((a, i) => (!moving.has(i) ? a : { at: a.at + dt, pos: own.has(i) ? a.pos + dp : a.pos }));
      // A moved Markers region's points go on the bookmarks in its new box; the selected points are found again by their times.
      const next = markersRegions(moved).reduce((list, r) => refilled(list, r, bookmarks), points);
      const times = new Set(ps.map((i) => actions[i].at + dt));
      const picked = next.flatMap((a, j) => (times.has(a.at) && !regionAt(moved, a.at) ? [j] : []));
      edit(`Move ${items(ps.length, rs)}`, (s) => ({ ...s, actions: next, regions: regions.map((r) => moved[rs.indexOf(r)] ?? r) }));
      select(picked, moved);
      return { actions: next, picked, regions: moved };
    };
    return { moving, dtMin, dtMax, dpMin: -Math.min(...depths), dpMax: 100 - Math.max(...depths), shifted };
  };

  /**
   * Move the selected points and regions in place one step with the arrow
   * key `key`, the regions only in time. In time, the first point, or the
   * first region's start, goes to the next of the whole 100 ms, with Shift
   * 1 s, counted from the time shown as 0; of the grid's lines; or, placing
   * on markers, the next bookmark out of the other regions; the next they can
   * reach. In depth, by 1, with Shift 10, or to the grid's next depth. One
   * edit per press.
   */
  const nudge = (key: string, far: boolean) => {
    const ps = [...selected].sort((a, b) => a - b);
    const { dtMin, dtMax, dpMin, dpMax, shifted } = inPlace(ps, chosen);
    const sign = key === "ArrowRight" || key === "ArrowUp" ? 1 : -1;
    const lead = actions[ps[0]] ?? { at: chosen[0].from, pos: 0 };
    /** The nearest of `stops` past `from` the way it goes, as a change within `min` to `max`; 0 without one. */
    const next = (from: number, stops: number[], min: number, max: number) => {
      const d = stops.map((v) => v - from).filter((d) => d * sign > 0 && d >= min && d <= max);
      return d.length ? d.reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)) : 0;
    };
    let [dt, dp] = [0, 0];
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const free = advanced && onMarkers ? bookmarks.filter((b) => !regionAt(regions.filter((r) => !chosen.includes(r)), b.time)).map((b) => b.time) : [];
      const every = grid?.step ?? (far ? 1000 : 100);
      const lines = [-1, 0, 1].map((k) => zero + (Math.round((lead.at - zero) / every) + k) * every);
      dt = next(lead.at, free.length ? free : lines, dtMin, dtMax);
    } else if (ps.length && !chosen.length) {
      dp = grid?.positions.length ? next(lead.pos, grid.positions, dpMin, dpMax) : clamp(sign * (far ? 10 : 1), dpMin, dpMax);
    }
    if (!dt && !dp) return;
    const last = shifted(dt, dp);
    if (boxMode) setBox(boxed(boxAround(last.picked.map((j) => last.actions[j]), last.regions)), last.actions);
  };

  /**
   * Drag a selection that is not consecutive, the points `ps` and the regions
   * `rs`, once it has gone 3 px: in place and live, each staying between the
   * other points and regions either side of it, from 0 on, so it passes none;
   * to pass them, select the whole stretch. The selected points follow the
   * pointer's depth, but not with a region. Ctrl (or Cmd) keeps their times
   * while dragged further in depth than in time on screen, else their depths.
   * Escape puts it back. One edit. Dragged by the point `grabbed`.
   */
  const dragApart = (e: PointerEvent<Element>, ps: number[], rs: Region[], grabbed = ps[0]) => {
    e.preventDefault();
    e.stopPropagation();
    const { moving, dtMin, dtMax, dpMin, dpMax, shifted } = inPlace(ps, rs);
    const [start, origin, x0, y0] = [{ actions, regions }, pointerAt(e), e.clientX, e.clientY];
    /** Whether it has started, and whether Escape has put it back since. */
    let [live, done] = [false, false];
    /** The points, the selected ones among them and the regions as last put. */
    let last: { actions: Action[]; picked: number[]; regions: Region[] } | null = null;
    const move = (m: globalThis.PointerEvent) => {
      if (done || (!live && Math.hypot(m.clientX - x0, m.clientY - y0) <= 3)) return;
      if (!live) {
        live = true;
        setDragging(true);
        setApart({ actions, moving, regions: rs, grip: actions[grabbed] });
        cancelApart.current = () => {
          done = true;
          setScript((s) => ({ ...s, ...start }));
          select(ps, rs);
          setApart(null);
        };
      }
      const p = pointerAt(m);
      const lock = m.ctrlKey || m.metaKey;
      setHeld({ shift: m.shiftKey, ctrl: lock });
      const up = Math.abs(y(p.pos) - y(origin.pos)) > Math.abs(x(p.at) - x(origin.at));
      // The point dragged by, or the first region's start, goes on the grid.
      const lead = actions[grabbed] ?? { at: rs[0].from, pos: 0 };
      const dt = lock && up ? 0 : clamp(gridAt(lead.at + p.at - origin.at) - lead.at, dtMin, dtMax);
      const dp = rs.length || (lock && !up) ? 0 : clamp(gridPos(lead.pos + p.pos - origin.pos) - lead.pos, dpMin, dpMax);
      last = shifted(dt, dp);
      if (actions[grabbed]) setApart((a) => a && { ...a, now: { at: lead.at + dt, pos: lead.pos + dp } });
    };
    track(e.currentTarget.closest("svg")!, e, move, () => {
      cancelApart.current = null;
      setApart(null);
      if (!live) return;
      if (boxMode && last && !done) setBox(boxed(boxAround(last.picked.map((j) => last!.actions[j]), last.regions)), last.actions);
      setDragging(false);
    });
  };


  /** Drag the playhead to seek; playback pauses while dragging, as in the player. */
  const dragPlayhead = (e: PointerEvent<SVGGElement>) => {
    // The points are drawn over the playhead.
    const hit = pointUnder(e);
    if (hit !== null) return pointDown(e, hit);
    const element = media.videoRef.current;
    if (!element || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget;
    const wasPlaying = !element.paused;
    element.pause();
    const move = (m: globalThis.PointerEvent) => media.seek(pointerAt(m).at);
    track(target, e, move, () => {
      if (wasPlaying) void element.play();
    });
  };

  /** The time the minimap shows: the script (the main one too, in the advanced editor), the video and the visible time, whichever is longest. */
  const total = Math.max(end, main.actions[main.actions.length - 1]?.at ?? 0, media.videoDuration, view.span);

  /** Unlock the region `r`: it goes, and its points become ordinary points, selected; an instance's regions become regions of their own, their points staying theirs. */
  const unlockRegion = (r: Region) => {
    const inner = isInstance(r) ? r.snippet.regions : [];
    edit(`Unlock ${regionNoun(r)}`, (s) => ({ ...s, regions: [...s.regions.filter((o) => o !== r), ...inner].sort((a, b) => a.from - b.from) }));
    select(pointsOf(r).filter((i) => !regionAt(inner, actions[i].at)));
  };

  /** The indices of the points in `r`'s time. */
  const pointsOf = (r: Region) => Array.from({ length: afterTime(actions, r.to) - byTime(actions, r.from) }, (_, k) => byTime(actions, r.from) + k);
  /** The selected points and regions' points, or all points, as the stats take them. */
  const statsPicked = useMemo(
    () => (selected.size || chosen.length ? [...new Set([...selected, ...chosen.flatMap(pointsOf)])].sort((a, b) => a - b) : [...actions.keys()]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the picked points follow from these
    [selected, regionsOn, regions, actions],
  );
  /** The stats' points, at least two, as the Speed Calculator follows them while open. */
  const calcScript = useMemo(() => {
    if (!calcShown || statsPicked.length < 2) return null;
    const points = statsPicked.map((i) => actions[i]);
    return { name: "", at: Uint32Array.from(points, (a) => a.at), pos: Float64Array.from(points, (a) => a.pos) };
  }, [calcShown, actions, statsPicked]);

  /** Give the region `r` the name `name`. */
  const renameRegion = (r: Region, name: string) => {
    const renamed = isInstance(r) ? { ...r, snippet: { ...r.snippet, name } } : { ...r, name };
    edit(`Rename ${regionNoun(r)} to "${name}"`, (s) => ({ ...s, regions: s.regions.map((o) => (o === r ? renamed : o)) }));
    select([], [renamed]);
  };
  // With a tool open, undo and redo go through its own history; undo past its start discards it.
  const canUndo = !dragging && (!!tool || timeline.index > 0);
  const canRedo = !dragging && (tool ? tools.canRedo : timeline.index < timeline.states.length - 1);
  // Else what is pending goes first, as with Escape: a drag in place, or what is being placed.
  const undo = () => (tool ? tools.undo() : discard() || (canUndo && jump(timeline.index - 1)));
  const redo = () => (tool ? canRedo && tools.redo() : discard() || (canRedo && jump(timeline.index + 1)));

  const maxSpan = Math.max(end, main.actions[main.actions.length - 1]?.at ?? 0, media.videoDuration, fnBox?.to ?? 0, MAX_SPAN_FLOOR);
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

  /** Delete the selected points and regions, the regions with their points, an instance with its regions; `verb` names the edit. */
  const removeSelected = (verb = "Delete") => {
    edit(`${verb} ${items(selected.size, chosen)}`, (s) => ({ ...s, actions: s.actions.filter((a, j) => !selected.has(j) && !regionAt(chosen, a.at)), regions: s.regions.filter((r) => !chosen.includes(r)) }));
    select([]);
  };

  // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes. Ctrl/Cmd+A selects all points but the regions', and the regions, or all bookmarks with markers
  // selected or over the marker lane; Escape none, Delete (or Backspace, the Mac's delete key) removes the selected ones; F2 renames the selected
  // markers, B adds a bookmark, P hides or shows the player, also with a tool open. The arrow keys move the selected points and regions, with Shift
  // further. Not while typing in a field.
  // With a tool open, Escape (also in its fields) discards it, and undo and redo go through its changes; other keys do nothing.
  useWindowEvent("keydown", (e) => {
    if (tool && e.key === "Escape") return setTool(null);
    if (e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase();
    if (key === "p" && !e.ctrlKey && !e.metaKey && media.videoUrl) return media.togglePlayer();
    if (tool && !((e.ctrlKey || e.metaKey) && (key === "z" || key === "y"))) return;
    if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "y")) {
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo();
      else undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      if (markers.marked.size || markers.overLane.current) markers.selectMarkers(bookmarks);
      else select([...actions.keys()].filter((i) => !regionAt(regions, actions[i].at)), regions);
    } else if (e.key === "Escape") {
      // What is pending goes first, then the grid, then the selection.
      if (discard()) return;
      if (gridOpen) setGridOpen(false);
      else {
        select([]);
        markers.setMarked(new Set());
        setBox(null);
      }
    } else if (e.key.startsWith("Arrow") && !e.ctrlKey && !e.metaKey && !e.altKey && !e.defaultPrevented && !dragging && (selected.size || chosen.length)) {
      e.preventDefault();
      nudge(e.key, e.shiftKey);
    } else if (e.key === "s" && !e.ctrlKey && !e.metaKey) {
      toggleBoxMode();
    } else if ((e.key === "Delete" || e.key === "Backspace") && (selected.size || chosen.length)) {
      e.preventDefault();
      removeSelected();
    } else if ((e.key === "Delete" || e.key === "Backspace") && markers.marked.size) {
      e.preventDefault();
      markers.removeMarkers([...markers.marked]);
    } else if (e.key === "F2" && markers.marked.size) {
      e.preventDefault();
      markers.rename([...markers.marked]);
    } else if (e.key === "e" && !e.ctrlKey && !e.metaKey) {
      // With a region alone selected, edits it instead.
      if (region) editRegion(region);
      else openAdvanced();
    } else if (key === "b" && !e.ctrlKey && !e.metaKey && !markersLocked) {
      // At the playhead, or without media under the pointer.
      const at = media.videoUrl ? Math.round(media.time) : hoverAt.current;
      if (at !== null) markers.addBookmark(at);
    }
  });

  /** The selected points and regions, with the regions' points, as funscript JSON, timed from the first point. */
  /** Also adds them to the clipboard history. */
  const selectionJson = () => {
    const picked = actions.filter((a, i) => selected.has(i) || regionAt(chosen, a.at));
    const t0 = picked[0].at;
    return remember({ actions: picked.map((a) => ({ at: a.at - t0, pos: a.pos })), regions: chosen.map((r) => movedBy(r, -t0)) });
  };

  const cut = () => removeSelected("Cut");

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

  /** Drop what is pending: the open tool, unapplied, else put back what is dragged in place, else stop placing; returns whether there was any. */
  const discard = () => {
    if (tool) setTool(null);
    else if (cancelApart.current) cancelApart.current();
    else if (placing) cancelPlacing();
    else return false;
    return true;
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
    setTimeline(startedAt({ ...doc, chapters, bookmarks }, library, "Open"));
    setAdvanced({ ...doc, zero, from, snippet, instance: instance && regions.indexOf(instance) });
    select([]);
    markers.setMarked(new Set());
    setBox(null);
  };

  /**
   * Leave the advanced editor for the main script and its undo history. Done
   * places the result with its regions where it was edited, as a move of the
   * points it was opened from dropped where they were, none when opened
   * empty, and adds it to the clipboard history; refused there, it follows
   * the pointer as a paste. Cancel drops it, the points it was opened from
   * selected again. In snippet mode, Done saves it to the library instead, a
   * new one as `name`. Editing an instance, Done places one instance of its
   * name in place of the original, and Cancel selects it again.
   */
  const closeAdvanced = (done: boolean, name?: string) => {
    const { actions: result, regions: made, from, snippet } = advanced!;
    const instance = advanced!.instance === undefined ? null : (main.regions[advanced!.instance] as Instance);
    setLeaving(false);
    // The snippet library's and markers' changes in the advanced editor go on in the main script's history.
    const base = mainTimeline.current ?? startedAt(main, timeline.states[0].library, "Start");
    const tl = withLibraryChanges(base, timeline, true);
    setTimeline(tl);
    // With the markers changed, its points as the last entry has them, their Markers regions' refilled alike, so they make no further edit.
    const [was, now] = [base.states[base.index], tl.states[tl.index]];
    if (now.chapters !== was.chapters || now.bookmarks !== was.bookmarks) setMain((m) => ({ ...m, actions: now.actions }));
    mainTimeline.current = null;
    setAdvanced(null);
    // Cancelled, an open tool goes too, unapplied, and the grid.
    setTool(null);
    setGridOpen(false);
    setBox(null);
    if (snippet) {
      if (done) saveSnippet(snippet.path ?? [name!], { actions: result, regions: made });
      setSelected(new Set());
      setLifted(null);
      setPlacing(null);
      return;
    }
    if (!done) {
      select(instance ? [] : from ?? [], instance ? [instance] : []);
      setLifted(null);
      setPlacing(null);
      return;
    }
    const own = instance ? [instanceOf(instance.snippet.name, { actions: result, regions: made })] : made;
    remember(clipBy({ actions: result, regions: own }, -result[0].at));
    // The stretch it was opened on is lifted, as a move's: the main script's other points and regions in it ride along, a point of the result taking the place of one at its time.
    const times = [...(from ?? []).map((i) => main.actions[i].at), ...(instance ? [instance.from, instance.to] : [])];
    const stretch = times.length ? { from: Math.min(...times), to: Math.max(...times) } : null;
    const opened = new Set(from);
    const taken = new Set(result.map((a) => a.at));
    const ride = stretch ? main.actions.filter((a, i) => a.at >= stretch.from && a.at <= stretch.to && !opened.has(i) && !taken.has(a.at)) : [];
    const along = stretch ? main.regions.filter((r) => r !== instance && r.from >= stretch.from && r.to <= stretch.to) : [];
    const all = [...result.map((a) => ({ a, mine: true })), ...ride.map((a) => ({ a, mine: false }))].sort((p, q) => p.a.at - q.a.at);
    const t0 = all[0].a.at;
    setPlacing({
      actions: all.map(({ a }) => ({ at: a.at - t0, pos: a.pos })),
      regions: [...own, ...along].map((r) => movedBy(r, -t0)),
      picked: { actions: all.map((p) => p.mine), regions: [...own.map(() => true), ...along.map(() => false)] },
      label: instance ? `Edit ${regionNoun(instance)}` : undefined,
    });
    setLifted(stretch && { ...stretch, points: opened, regions: instance ? [instance] : [] });
    setPlaceAt(all[0].a);
    setSettle("try");
  };

  /** Whether the advanced editor's document differs from what it was opened on. */
  const advancedChanged = () => {
    const { actions: result, regions: made, from, zero, snippet } = advanced!;
    const instance = advanced!.instance === undefined ? null : (main.regions[advanced!.instance] as Instance);
    // Opened on points, it has no regions, so any is a change.
    const original = snippet ? snippetFrom(snippet.path, zero) : { actions: from?.map((i) => main.actions[i]) ?? [], regions: instance?.snippet.regions ?? [] };
    return JSON.stringify({ actions: result, regions: made }) !== JSON.stringify(original);
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
      markers.setMarked(new Set());
      const opened = Array.from(parsed.at, (at, i) => ({ at, pos: parsed.pos[i] }));
      const fileMarkers = readMarkers(rest, Math.max(opened[opened.length - 1].at, media.videoDuration));
      // Taken as they are, never generated again.
      const regions = readRegions((rest.ossmRsWebTools as { regions?: unknown } | null | undefined)?.regions);
      const next = { name: file.name.replace(/\.funscript$/, ""), actions: opened, file: rest, ...fileMarkers, regions };
      setSaved(next);
      setScript(next);
      setTimeline(withLibraryChanges(startedAt(next, timeline.states[0].library, `Open ${file.name}`), timeline));
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
    const written = writeMarkers(chapters, bookmarks);
    if (chapters.length || "chapters" in metadata) metadata.chapters = written.chapters;
    if (bookmarks.length || "bookmarks" in metadata) metadata.bookmarks = written.bookmarks;
    // Into the opened file's "ossmRsWebTools", our own key; the regions only when there are some or the file had them.
    const ossmRsWebTools = { ...(file.ossmRsWebTools as Record<string, unknown> | undefined) };
    if (regions.length || "regions" in ossmRsWebTools) Object.assign(ossmRsWebTools, { version: 1, regions: [...regions].sort((a, b) => a.from - b.from) });
    download({
      version: "1.0",
      inverted: false,
      range: 100,
      ...file,
      actions,
      ...(Object.keys(metadata).length || "metadata" in file ? { metadata } : {}),
      ...(Object.keys(ossmRsWebTools).length || "ossmRsWebTools" in file ? { ossmRsWebTools } : {}),
    }, `${script.name || "untitled"}.funscript`);
    setSaved(script);
  };

  /** The point being placed or dragged apart dragged by, else the first, where it came from: a paste's depth alone, as it came from no time. */
  const dragged = placing && placeAt ? { at: placing.from === undefined ? undefined : placing.from + placing.actions[placing.grip ?? 0].at, pos: placing.actions[placing.grip ?? 0].pos } : apart?.grip;

  // The points in view and one beyond each edge, so the line reaches the edges.
  const first = Math.max(byTime(shown, view.from) - 1, 0);
  const last = Math.min(byTime(shown, view.from + view.span) + 1, shown.length);
  const visible = shown.slice(first, last);
  /** The index of the point under the pointer, the one drawn on top if several, or null. */
  const pointUnder = (e: { clientX: number; clientY: number }) => {
    const rect = boxRef.current!.getBoundingClientRect();
    const [px, py] = [e.clientX - rect.left, e.clientY - rect.top];
    const near = (dx: number) => byTime(visible, view.from + ((px + dx) / width) * view.span);
    // Selected points are drawn last, on top.
    let hit = null;
    for (let j = near(-8); j < near(8); j++) {
      const i = first + j;
      if (regionAt(shownRegions, visible[j].at) || Math.hypot(x(visible[j].at) - px, y(visible[j].pos) - py) > (selected.has(i) ? 8 : 5)) continue;
      if (hit === null || selected.has(i) || !selected.has(hit)) hit = i;
    }
    return hit;
  };

  /** What GraphCanvas draws dashed behind the line: with a tool open, the points it was opened on; moving, the lifted points, but the moved regions', and a lone point's ring. */
  const dashed = tool || lifted ? (() => {
    const all = tool?.actions ?? actions;
    const a = !tool ? all.slice(byTime(all, lifted!.from), afterTime(all, lifted!.to))
      : tool.kind !== "repeat" ? all : repParams ? all.slice(byTime(all, repBox.from), afterTime(all, repBox.from + repParams.length)) : [];
    const moved = tool ? [] : regions.filter((r) => r.from >= lifted!.from && r.to <= lifted!.to);
    return { points: a, movedRegions: moved, ring: !tool && a.length === 1 && !regionAt(regions, a[0].at) };
  })() : null;
  /**
   * Buttons in the middle of the selection box's edges, in its part in view,
   * that grow it to the start or end of the script, or the top or bottom; each
   * only while that edge is not there yet; and in its middle, where the By
   * time toggle goes. None in a box too small for them.
   */
  const boxButtons = (() => {
    if (!boxMode || placing || !box || !edges) return null;
    const [left, right] = [Math.max(edges.from, 0), Math.min(edges.to, width)];
    const [midX, midY] = [(left + right) / 2 - EXTEND / 2, (edges.high + edges.low) / 2 - EXTEND / 2];
    if (right - left < 3 * EXTEND + 16 || edges.low - edges.high < 3 * EXTEND + 16) return null;
    const extenders = ([
      ["Extend the selection to the start", DoubleArrowLeftIcon, { from: 0 }, box.from > 0, left + 6, midY],
      ["Extend the selection to the end", DoubleArrowRightIcon, { to: end }, box.to < end, right - 6 - EXTEND, midY],
      ["Extend the selection to the top", DoubleArrowUpIcon, { high: 100 }, box.high < 100, midX, edges.high + 6],
      ["Extend the selection to the bottom", DoubleArrowDownIcon, { low: 0 }, box.low > 0, midX, edges.low - 6 - EXTEND],
    ] as const).filter(([, , , shown]) => shown);
    return { extenders, middle: { left: midX, top: midY } };
  })();

  /** The advanced editor's Done, as `label`. In snippet mode, it saves to the library, a new snippet under a name, so it needs a length. */
  const newSnippet = !!advanced?.snippet && !advanced.snippet.path;
  const doneButton = (label: ReactNode) => advanced && (newSnippet ? (
    <NamePopover taken={(n) => nameTaken([], n)} onName={(n) => closeAdvanced(true, n)}>
      <Button style={{ flex: 1 }} disabled={actions.length < 2}>{label}</Button>
    </NamePopover>
  ) : (
    <Button style={{ flex: 1 }} disabled={actions.length < (advanced.snippet || advanced.instance !== undefined ? 2 : 1)} onClick={() => closeAdvanced(true)}>{label}</Button>
  ));

  /** What the advanced editor is editing, in place of the script's name. */
  const advancedTitle = advanced && (advanced.instance !== undefined ? `Snippet · ${(main.regions[advanced.instance] as Instance).snippet.name}` : !advanced.snippet ? "Advanced editor" : advanced.snippet.path ? `Snippet · ${advanced.snippet.path[advanced.snippet.path.length - 1]}` : "New snippet");

  /**
   * Send the points to the player, which loads them at once in other tabs and on opening; the advanced
   * editor's from 0, without the markers. Switches to the player's tab, or opens it in a new one. Only
   * a tab opened from this one can be found by its name, so one the user opened stays in the background.
   */
  const sendToPlayer = () => {
    const sent = advanced ? actions.map((a) => ({ ...a, at: a.at - actions[0].at })) : actions;
    const metadata = advanced ? undefined : writeMarkers(chapters, bookmarks);
    localStorage.setItem(SENT_SCRIPT_KEY, JSON.stringify({ name: advancedTitle || script.name || "untitled", actions: sent, metadata, sent: Date.now() }));
    const tab = window.open("", PLAYER_WINDOW);
    if (tab?.location.href === "about:blank") tab.location.href = new URL("player", location.href).href;
    tab?.focus();
  };

  /** Show the time `t` ms: the view centred on it when it is out of view, and the playhead there. */
  const goTo = (t: number) => {
    if (t < view.from || t > view.from + view.span) setView({ ...view, from: clamp(t - view.span / 2, 0, Math.max(total - view.span, 0)) });
    media.seek(t);
  };

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
            if (!discardable()) return;
            setLifted(null);
            setSelected(new Set());
            markers.setMarked(new Set());
            setSaved(EMPTY);
            setScript(EMPTY);
            setTimeline(withLibraryChanges(startedAt(EMPTY, timeline.states[0].library, "New script"), timeline));
            setView((v) => ({ ...v, from: 0 }));
          }}
        >
          <FileIcon /> New
        </Button>
        <Button variant="soft" style={{ flex: 1 }} onClick={() => discardable() && input.current?.click()}>
          <UploadIcon /> Open
        </Button>
      </Flex>}
      {!tool && <Flex gap="2">
        <Button variant="soft" style={{ flex: 1 }} onClick={media.chooseFile}>
          <UploadIcon /> {media.videoFile ? "Change media" : "Open media"}
        </Button>
        {media.videoFile && (
          <Button
            variant="soft"
            color="gray"
            onClick={media.close}
          >
            <Cross2Icon /> Close
          </Button>
        )}
      </Flex>}
      {!advanced && <>
      <Box>
        <Text as="label" size="2" weight="medium" mb="1" style={{ display: "block" }} htmlFor="editor-name">Name</Text>
        <TextField.Root id="editor-name" value={script.name} onChange={(e) => setScript({ ...script, name: e.target.value })}>
          {media.videoFile && (
            <TextField.Slot side="right">
              <IconButton
                size="1"
                variant="ghost"
                aria-label="Name after the media"
                title="Name after the media"
                onClick={() => setScript({ ...script, name: media.videoFile!.name.replace(/\.[^.]+$/, "") })}
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
      {/* With a tool open, the grid's too, the panel only has the tool. */}
      {!tool && !gridOpen && <>
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
      {advanced && <>
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
      </>}
      {/* The selected region, its points locked until unlocked. */}
      {region && (
        <RegionPanel
          region={region}
          pointCount={afterTime(actions, region.to) - byTime(actions, region.from)}
          disabled={!!placing}
          onEdit={() => editRegion(region)}
          onUnlock={() => unlockRegion(region)}
          onDelete={() => removeSelected()}
          onRename={(n) => renameRegion(region, n)}
          onSave={(n) => saveSnippet([n], { actions: actions.slice(byTime(actions, region.from), afterTime(actions, region.to)), regions: generators([region]) })}
          nameTaken={(n) => nameTaken([], n)}
        />
      )}
      {/* Stats of the selected points and regions' points, or of all points. */}
      {actions.length > 0 && (() => {
        const on = selected.size || chosen.length;
        const picked = statsPicked;
        if (!picked.length) return null;
        const average = !statsShown && stats(actions, picked).average;
        return <>
          <Separator size="4" />
          {/* Collapsed, the average speed, when there are moves. */}
          <SectionHeader title={on ? "Selection stats" : "Stats"} open={statsShown} setOpen={setStatsShown} summary={!!average && `${Math.round(average)}/s avg`} />
          {statsShown && <Stats actions={actions} picked={picked} size="2" />}
        </>;
      })()}
      <Separator size="4" />
      <SpeedCalculator open={calcShown} setOpen={setCalcShown} script={calcScript} selection={selected.size > 0 || chosen.length > 0} />
      </>}
      <ToolPanel tools={tools} advanced={!!advanced} actions={actions} regions={regions} bookmarks={bookmarks} zero={zero} selectedCount={selected.size} placing={!!placing} />
      {/* At the panel's bottom as a tool's Apply, which takes its place while a tool is open, or the grid. */}
      {!tool && !gridOpen && (
        <Flex direction="column" gap="2" py="3" mb="-3" style={{ marginTop: "auto", position: "sticky", bottom: 0, background: "var(--color-background)" }}>
          {/* The sent stamp makes every send a change, which other tabs hear of. */}
          <Button variant="soft" disabled={actions.length < 2} title="Play these points in the player" onClick={sendToPlayer}>
            <PlayIcon /> Send to player
          </Button>
          {advanced && <>
            {/* At the top level of the library; the editor stays open. A snippet's Save does it. */}
            {!advanced.snippet && <NamePopover taken={(n) => nameTaken([], n)} onName={(n) => saveSnippet([n], { actions, regions })}>
              <Button variant="soft" disabled={actions.length < 2} title="Save the whole document to the snippet library">
                <SnippetIcon /> Save as snippet
              </Button>
            </NamePopover>}
            <Flex gap="2">
              {doneButton(advanced.snippet ? <><SnippetIcon /> Save</> : "Done")}
              <Button variant="soft" color="gray" style={{ flex: 1 }} onClick={() => (!advancedChanged() || confirm("Discard the advanced editor's changes?")) && closeAdvanced(false)}>Cancel</Button>
            </Flex>
          </>}
        </Flex>
      )}
    </Flex>
  );

  /** Whether the time from `from` to `to` is in view, to draw only the markers there. */
  const inView = (from: number, to: number) => to >= view.from && from <= view.from + view.span;

  const light = lightChapters(chapters);

  /** The point labelled with its time and position: the one dragged by while moving, else the selected point when there is just one. */
  const labelled = (placing?.grip !== undefined && landed ? landed[placing.grip] : apart?.now) ?? (marks.size === 1 ? shown[[...marks][0]] : undefined);

  const content = (
    <Flex direction="column" gap="3" p="3" height="100%">
      <MediaPlayer media={media} actions={actions} view={view} />
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
          <UndoHistory timeline={timeline} onJump={jump} />
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
          {history.length > 0 && <ClipboardHistory history={history} onPaste={pasteFromHistory} disabled={!!tool} />}
        </Flex>
        <Separator orientation="vertical" size="2" />
        <Button
          variant={boxMode ? "solid" : "soft"}
          color={boxMode ? undefined : "gray"}
          aria-pressed={boxMode}
          disabled={!!tool || !!placing}
          title="Select points and regions with a box (S)"
          onClick={toggleBoxMode}
        >
          {/* A dashed selection box, sized like the icons. */}
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <rect x="2" y="2" width="11" height="11" rx="1" stroke="currentColor" strokeDasharray="2 2" />
          </svg>
          Select
        </Button>
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
        {media.videoUrl && <>
          <Separator orientation="vertical" size="2" />
          <Button
            variant={media.playerShown ? "solid" : "soft"}
            color={media.playerShown ? undefined : "gray"}
            aria-pressed={media.playerShown}
            title={`${media.playerShown ? "Hide" : "Show"} the ${media.isAudio ? "audio" : "video"} player (P)`}
            onClick={media.togglePlayer}
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
              // Pasted points follow the pointer; dragged ones the drag.
              if (!carrying.current) setPlaceAt(pointerAt(e));
              setHeld({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
            }}
            onPointerLeave={() => !carrying.current && setPlaceAt(null)}
            // A snippet's row dragged here goes in where it is released, unless refused there.
            onPointerUp={(e) => {
              if (!rowDrag || !placing) return;
              const [pasted, insert] = landedAt(e);
              if (pasted) put(pasted, insert);
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
            {/* Moving, the regions moved where they were, dashed. */}
            {(lifted ? regions.filter((r) => r.from >= lifted.from && r.to <= lifted.to) : apart?.regions ?? []).filter((r) => inView(r.from, r.to)).map((r, i) => (
              <rect key={`l${i}`} x={x(r.from)} width={x(r.to) - x(r.from)} height={plotHeight} strokeDasharray="4 3" style={{ fill: "none", stroke: "var(--gray-a9)" }} />
            ))}
            {/* The regions' bands over them, with those being placed, the selected ones outlined as the selected markers; their labels are in the box. */}
            {shownRegions.map((r, i) => inView(r.from, r.to) && (
              // Selected, inset by half its outline, as the selected markers', so the graph's edges don't cut it.
              <rect
                key={`r${i}`}
                x={x(r.from) + (outlined(r) ? 1 : 0)}
                y={outlined(r) ? 1 : 0}
                width={Math.max(x(r.to) - x(r.from) - (outlined(r) ? 2 : 0), 0)}
                height={plotHeight - (outlined(r) ? 2 : 0)}
                strokeWidth={outlined(r) ? 2 : 1}
                style={outlined(r) ? { fill: bandOf(r).selectedFill, stroke: "var(--accent-9)" } : { fill: bandOf(r).fill, stroke: bandOf(r).stroke }}
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
            {/* The grid's lines while it is open; its times only while 4 px apart or more. */}
            {grid && (
              <g strokeDasharray="2 3" style={{ stroke: "var(--accent-a7)" }}>
                {grid.positions.map((pos) => <line key={`gp${pos}`} x1={0} x2={width} y1={y(pos)} y2={y(pos)} />)}
                {grid.step && (grid.step / view.span) * width >= 4 && (() => {
                  const [k0, k1] = [Math.ceil((view.from - zero) / grid.step), Math.floor((view.from + view.span - zero) / grid.step)];
                  return Array.from({ length: Math.max(k1 - k0 + 1, 0) }, (_, k) => zero + (k0 + k) * grid.step!).map((t) => <line key={`gt${t}`} x1={x(t)} x2={x(t)} y1={0} y2={plotHeight} />);
                })()}
              </g>
            )}
            {/* Faint lines from the bookmarks in the lane up through the graph. */}
            {bookmarks.filter((b) => inView(b.time, b.time)).map((b, i) => (
              <line key={`b${i}`} x1={x(b.time)} x2={x(b.time)} y1={0} y2={height} style={{ stroke: `var(--${markerColor(b.name)}-a6)` }} />
            ))}
            {media.videoUrl && (
              <g onPointerDown={dragPlayhead} style={{ cursor: "ew-resize" }}>
                {/* A wider, invisible line to grab. */}
                <line x1={x(media.time)} x2={x(media.time)} y1={0} y2={plotHeight} strokeWidth={12} stroke="transparent" />
                <line x1={x(media.time)} x2={x(media.time)} y1={0} y2={plotHeight} strokeWidth={2} style={{ stroke: "var(--gray-12)" }} />
                <path d={`M${x(media.time) - 6},0 h12 l-6,8 z`} style={{ fill: "var(--gray-12)" }} />
              </g>
            )}
            {/* Where the points being placed can't go in, the time they would cover, red. */}
            {astray && (
              <rect
                x={x(astray.span[0])}
                width={Math.max(x(astray.span[1]) - x(astray.span[0]), 1)}
                y={0}
                height={plotHeight}
                style={{ fill: "var(--red-a3)", stroke: "var(--red-9)", pointerEvents: "none" }}
              />
            )}
            <GraphCanvas
              viewport={viewport}
              view={view}
              context={context}
              visible={visible}
              first={first}
              marks={marks}
              shownRegions={shownRegions}
              lit={tool ? [] : shownRegions.filter(outlined)}
              dashed={dashed}
              apart={apart}
              removed={removed}
              // Repeat's copies show thin and faded, so its pattern's line stands out; the line breaks between them, to be drawn over.
              muted={tool?.kind === "repeat" && !ghost}
              dotsAllowed={!tool}
              astray={astray && { points: astray.points, carried: carriedBy(ghost!) }}
            />
            {/* Holding Ctrl, the axes through where the point dragged by came from, along which it keeps them. */}
            {dragged && held.ctrl && (
              <g strokeDasharray="6 4" style={{ stroke: LINE_COLOR, opacity: 0.6, pointerEvents: "none" }}>
                <line x1={0} x2={width} y1={y(dragged.pos)} y2={y(dragged.pos)} />
                {dragged.at !== undefined && <line x1={x(dragged.at)} x2={x(dragged.at)} y1={0} y2={plotHeight} />}
              </g>
            )}
            {/* While placing, a click anywhere places, over points and the playhead alike. */}
            {placing && (
              // No menu for Ctrl+click, which is a right-click on a Mac.
              <rect width={width} height={height} fill="transparent" style={{ cursor: refused ? "not-allowed" : lifted ? "grabbing" : "copy" }} onPointerDown={place} onContextMenu={(e) => e.preventDefault()} />
            )}
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
            <ToolHandles tools={tools} viewport={viewport} />
            {labelled && (
              <text
                x={x(labelled.at)}
                y={y(labelled.pos) + (labelled.pos > 80 ? 22 : -12)}
                textAnchor="middle"
                fontSize={12}
                style={{ fill: "var(--gray-12)" }}
              >
                {formatScriptTime((labelled.at - zero) / 1000, 2)} · {Math.round(100 - labelled.pos)}
              </text>
            )}
          </svg>
          {boxButtons?.extenders.map(([label, Icon, sides, , left, top]) => (
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
          {boxButtons && (
            <IconButton
              size="1"
              variant={selectByTime ? "solid" : "surface"}
              aria-pressed={selectByTime}
              aria-label="Select by time, at any depth"
              title="Select by time, at any depth"
              style={{ position: "absolute", ...boxButtons.middle }}
              onClick={() => {
                setSelectByTime(!selectByTime);
                if (!selectByTime) selectIn({ ...box!, low: 0, high: 100 });
              }}
            >
              <HeightIcon />
            </IconButton>
          )}
          {/* Each region's label in its band's top corner, kept in view and cut off where there is no room. */}
          {shownRegions.map((r, i) => inView(r.from, r.to) && (
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
        <TimingView tools={tools} viewport={viewport} />
        <MarkerLane
          markers={markers}
          chapters={chapters}
          bookmarks={bookmarks}
          view={view}
          viewport={viewport}
          locked={markersLocked}
          lock={advanced ? { unlocked: markersUnlocked, toggle: () => {
            setMarkersUnlocked(!markersUnlocked);
            markers.setMarked(new Set());
          } } : null}
        />
      </Flex>
      {minimap ? (
        <Minimap
          actions={actions}
          total={total}
          chapters={chapters}
          bookmarks={bookmarks}
          window={view}
          onDrag={(from, playing) => {
            const start = clamp(from, 0, total - view.span);
            setView((v) => ({ ...v, from: start }));
            // Playing, the view follows the playhead, so the drag seeks.
            if (playing) media.seek(Math.max(from + view.span * FOLLOW_AT, 0));
          }}
          playheadAt={media.videoUrl ? media.time : null}
          media={media.videoRef}
          regions={[...(advanced ? main.regions : []), ...regions]}
          context={context}
          selected={{ of: kept, indices: selected }}
        />
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
  const asidePanel = <Flex data-aside direction="column" minHeight="100%">
    <Box p="3" pb="0">
      <SegmentedControl.Root value={asideTab} onValueChange={(v) => setAsideTab(v as "markers" | "snippets")} style={{ width: "100%" }}>
        <SegmentedControl.Item value="markers">Markers</SegmentedControl.Item>
        <SegmentedControl.Item value="snippets">Snippets</SegmentedControl.Item>
      </SegmentedControl.Root>
    </Box>
    {asideTab === "markers" ? <MarkersPanel markers={markers} chapters={chapters} bookmarks={bookmarks} locked={markersLocked} onGoTo={goTo} /> : <SnippetsPanel library={snippetLibrary} advanced={!!advanced} placing={!!placing} tool={!!tool} onOpenSnippet={(path) => openAdvanced({ path })} />}
  </Flex>;

  return <GraphLayout sidebar={sidebar} content={content} aside={asideShown && asidePanel} />;
}
