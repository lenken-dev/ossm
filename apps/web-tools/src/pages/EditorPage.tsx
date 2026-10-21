import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactElement, type ReactNode } from "react";
import { AlertDialog, Box, Button, Callout, Checkbox, Flex, Heading, HoverCard, IconButton, Popover, SegmentedControl, Select, Separator, Slider, Switch, Text, TextField, useThemeContext } from "@radix-ui/themes";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, ClipboardIcon, MagnifyingGlassIcon, PlusIcon, LockClosedIcon, LockOpen1Icon, Pencil1Icon, TrashIcon, MixerHorizontalIcon, CopyIcon, ResetIcon, CounterClockwiseClockIcon, DoubleArrowDownIcon, DoubleArrowLeftIcon, DoubleArrowRightIcon, DoubleArrowUpIcon, Cross2Icon, Crosshair2Icon, DownloadIcon, ExclamationTriangleIcon, FileIcon, GearIcon, HeightIcon, OpenInNewWindowIcon, PauseIcon, PlayIcon, ScissorsIcon, ShuffleIcon, TrackNextIcon, TrackPreviousIcon, UploadIcon, VideoIcon, ViewVerticalIcon } from "@radix-ui/react-icons";
import { bisectLeft, bisectRight } from "d3";
import { usePersistedState } from "../hooks/usePersistedState";
import { useWindowEvent } from "../hooks/useWindowEvent";
import { PLAYER_WINDOW, SENT_SCRIPT_KEY } from "../StreamPanel";
import { formatScriptTime, formatTimeTick, readFunscript, timeTicks } from "../StreamPanel";
import { LabeledSlider } from "../TrajectoryPanel";
import { clamp, LINE_COLOR, points, speed, stats, type Action } from "../funscript/model";
import { lightChapters, markerColor, readMarkers, writeMarkers, type Bookmark, type Chapter, type Marker } from "../funscript/markers";
import { SectionHeader, Stats } from "../funscript/widgets";
import { NamePopover, SnippetIcon } from "../editor/NamePopover";
import { afterTime, bandOf, byTime, clipBy, EMPTY, extended, generators, instanceOf, isInstance, isRepeat, items, markersRegions, movedBy, regionAt, regionName, regionNoun, sameContent, spanned, swapped, type Advanced, type Area, type Clip, type Content, type Inner, type Instance, type Placing, type Region, type Script } from "../editor/model";
import { fastestOf, gridParams, scaled, scaleParams, shifted, shiftParams, speedLimited, typed, type GridFields } from "../editor/transforms";
import { extent, funcAt, GENERATE_DEFAULTS, generated, KNOT_GAP, newSeed, ownScale, RANGED, rangeFields, rangeParams, refilled, REPEAT_DEFAULTS, repeated, repeatParams, reshaped, SHAPES, SPANNED, splineAt, TOOLS, withBookmarks, type Func, type FuncKey, type GenerateSetup, type GenPart, type Knots, type RepeatSetup, type Shape, type ShapeField, type ToolKind } from "../editor/generate";
import { download, readClip, readRegions } from "../editor/file";
import { entryAt, entryName, isFolder, isPreset, itemsAt, matching, merged, PRESETS, readEntries, sortedEntries, under, updatedAt, type Entry, type Folder, type LibraryFile, type Snippet } from "../editor/library";
import { changedSpan, HISTORY_SIZE, startedAt, UNDO_SIZE, withLibraryChanges, type Timeline } from "../editor/history";
import { bookmarkItem, chapterItem, diffPieces, LanePreview, PreviewGraph, regionItem } from "../editor/previews";
import { dragHeight } from "../drag";
import { AXIS, PAD, useViewport } from "../editor/viewport";
import { Minimap } from "../editor/Minimap";
import { SpeedCalculator } from "../editor/SpeedCalculator";
import { RegionPanel } from "../editor/RegionPanel";
import { GraphLayout } from "./GraphPage";

/** The selection box's edges, then its corners on top, as the sides dragging them changes. */
const GRIPS = [["from", null], ["to", null], [null, "high"], [null, "low"], ["from", "high"], ["to", "high"], ["from", "low"], ["to", "low"]] as const;
/** How the selection box and the tools' boxes in the graph fill and outline. */
const TOOL_BOX = { fill: "var(--accent-a3)", stroke: "var(--accent-9)" };
/** Size of the selection box's grips, in px. */
const GRIP = 8;
/** Size of the buttons in the selection box that extend it, in px. */
const EXTEND = 24;

/** Visible time range, in ms; at most the script (the main one too, in the advanced editor), Generate's box or the video, whichever is longer, but at least the floor, room to generate into a blank script. */
const MIN_SPAN = 500;
const MAX_SPAN_FLOOR = 120_000;
/** Steps of the visible time slider, in s; the first that keeps it to about this many steps is used. */
const SPAN_STEPS = [0.5, 1, 2, 5, 10, 15, 30, 60];
const SPAN_STEP_COUNT = 240;

/** Below this average spacing between the points in view, in px, the points are not drawn, only the line. */
const DOT_SPACING = 6;
/** A run of up to this many neighbouring selected points in view also shows rings on the points. */
const RING_LIMIT = 50;

/** Least and first height of the view of Generate's Interval or Speed below the graph, in px. */
const TIMING_HEIGHT = 80;

/** Height of the marker lane below the graph, in px. */
const LANE_HEIGHT = 24;
/** How the selected markers show in the lane. */
const SELECTED_MARKER = { outline: "2px solid var(--accent-9)", outlineOffset: -2 };
/** Width of the grips on a chapter's edges in the lane, in px. */
const MARKER_GRIP = 6;

/** Default and smallest height of the reference video, in px. */
const VIDEO_HEIGHT = 300;
const VIDEO_MIN_HEIGHT = 80;
/** Where the playhead stays in view while the video plays, as a fraction of the visible time. */
const FOLLOW_AT = 0.2;
/** Time steps of the seek buttons, in s, as typed; the first is always shown, empty ones are hidden. */
const DEFAULT_STEPS = ["1", "", ""];

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
  /** What the next edit is called in the undo history. */
  const editLabel = useRef<string | null>(null);
  /** The snippet library, shared by all scripts, as its file holds it. */
  const [libraryFile, setLibraryFile] = usePersistedState<LibraryFile>("ossm:editorSnippets", { ossmRsWebTools: { version: 1, snippets: [] } }, localStorage);
  const library = libraryFile.ossmRsWebTools.snippets;
  /** The library as it shows: the presets, then the user's entries. */
  const shelf = [...PRESETS, ...library];
  /** Change the snippet library as an edit called `label`. */
  const setLibrary = (label: string, f: (lib: Entry[]) => Entry[]) => {
    editLabel.current = label;
    setLibraryFile((l) => ({ ossmRsWebTools: { version: 1, snippets: f(l.ossmRsWebTools.snippets) } }));
  };
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
  const [rowDrag, setRowDrag] = useState<{ paths: string[][]; x: number; y: number; inPanel: boolean } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  /** The library's selected rows, by their paths as JSON, to move together; and the last one clicked, which Shift selects from. */
  const [rowsPicked, setRowsPicked] = useState<Set<string>>(new Set());
  const rowAnchor = useRef<string | null>(null);
  // A press anywhere but on a library row drops the selection.
  useEffect(() => {
    if (!rowsPicked.size) return;
    const down = (e: globalThis.PointerEvent) => !(e.target as Element).closest?.("[data-library-row]") && setRowsPicked(new Set());
    // Capturing, as the graph's presses stop there.
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [rowsPicked]);
  const libraryInput = useRef<HTMLInputElement>(null);
  const [view, setView] = usePersistedState("ossm:editorView", { from: 0, span: 10_000 });
  /** The view for drags, which read it between renders as they scroll it. */
  const viewRef = useRef(view);
  viewRef.current = view;
  /** The points for drags, which read them between renders. */
  const actionsRef = useRef(script.actions);
  actionsRef.current = script.actions;
  const [error, setError] = useState<string | null>(null);
  /** Indices of the selected points, moved together with the selected regions and deleted with the Delete key. */
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  /** The selected regions, selected, moved and deleted with the points; only while in the script. */
  const [regionsOn, setRegionsOn] = useState<Set<Region>>(() => new Set());
  /** The selected markers, moved, renamed and deleted together: a chapter, or bookmarks; selecting points or regions clears them, and they the regions. */
  const [marked, setMarked] = useState<Set<Marker>>(() => new Set());
  useEffect(() => {
    if (selected.size || regionsOn.size) setMarked(new Set());
  }, [selected, regionsOn]);
  useEffect(() => {
    if (marked.size) setRegionsOn(new Set());
  }, [marked]);
  /** Select the points `ps` and the regions `rs`, and nothing else. */
  const select = (ps: Iterable<number>, rs: Iterable<Region> = []) => {
    setSelected(new Set(ps));
    setRegionsOn(new Set(rs));
  };
  /** The marker last clicked without Shift, where a Shift+click range of bookmarks starts. */
  const markerAnchor = useRef<Marker | null>(null);
  /** Whether the pointer is over the marker lane, where Ctrl/Cmd+A selects all bookmarks. */
  const overLane = useRef(false);
  /** What a new bookmark is called: the name last given to one, for this visit to the page; none until then. */
  const [lastName, setLastName] = useState<string | null>(null);
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
  /**
   * Points being placed, timed from the first, with the regions they carry,
   * following the pointer until a click or a drag's release places them; with
   * the `picked` ones of them, the selection being moved, which alone take the
   * depth change and are selected once placed (all without), what the edit
   * is called and, moved or added, the time its first point came from.
   */
  const [placing, setPlacing] = useState<Placing | null>(null);
  /**
   * The stretch of the script being moved, from its first to its last
   * selected item, left out of the script with every point and region in it,
   * the gap closed, until placed, with the selection to put back on Escape.
   * None for a paste.
   */
  const [lifted, setLifted] = useState<{ from: number; to: number; points: Set<number>; regions: Region[] } | null>(null);
  /** Where the first point being placed is, under the pointer. */
  const [placeAt, setPlaceAt] = useState<Action | null>(null);
  /** Set while a drag carries what is being placed, which then follows the drag, not the pointer's moves over the graph. */
  const carrying = useRef(false);
  /** Set on a drag's release, to put in what it carried, or by Done, to put in its result; see where it is used. */
  const [settle, setSettle] = useState<"drop" | "try" | null>(null);
  /** While a selection that is not consecutive is dragged in place, the points as they were, which of them move, its regions as they were, drawn dashed, and the point dragged by, else the first, as it was and, once moved, as it is `now`. */
  const [apart, setApart] = useState<{ actions: Action[]; moving: Set<number>; regions: Region[]; grip?: Action; now?: Action } | null>(null);
  /** While one is dragged, puts it back where it was, for Escape. */
  const cancelApart = useRef<(() => void) | null>(null);
  /** Selection mode's box selects by time: it takes in whole stretches of the script, whatever their depth. */
  const [selectByTime, setSelectByTime] = usePersistedState("ossm:editorSelectByTime", false, localStorage);
  /**
   * Modifiers held while placing: Shift replaces the points covered instead
   * of inserting, Ctrl (or Cmd) keeps the copied depths instead of following
   * the pointer's, or moved or added points their time; see `upright`.
   */
  const [held, setHeld] = useState({ shift: false, ctrl: false });
  const inserting = !held.shift;
  /** The latest copies, newest first; for this visit to the page. */
  const [history, setHistory] = useState<Clip[]>([]);
  /** The selection box, with the points it was drawn on; it goes when they change. */
  const [boxOn, setBoxOn] = useState<{ area: Area; actions: Action[] } | null>(null);
  const box = boxOn?.actions === script.actions ? boxOn.area : null;
  const setBox = (area: Area | null, on = script.actions) => setBoxOn(area && { area, actions: on });
  /** The point or region last clicked without Shift, by its time, where a Shift+click range starts. */
  const anchor = useRef<{ from: number; to: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  /** The graph and the marker lane, which scroll and zoom alike. */
  const timeRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Re-rendered on a theme change, so the canvas picks up its colours. Radix's own context, as the theme's colours change a render after the app's appearance does.
  useThemeContext();
  const viewport = useViewport(boxRef, viewRef, setView);
  const { width, height, plotHeight, x, y, pointerAt, track } = viewport;
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
  /** The sidebar's stats are expanded, else just their header. */
  const [statsShown, setStatsShown] = usePersistedState("ossm:editorStatsShown", true, localStorage);
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
  /** The grid tool is open; unlike the other tools, editing goes on, points added, dragged and placed snapping to it. */
  const [gridOpen, setGridOpen] = useState(false);
  const [gridFields, setGridFields] = usePersistedState<GridFields>("ossm:editorGrid", { time: "1", depth: "10", depths: "" }, localStorage);
  /** The grid, while its tool is open in the advanced editor and no other tool is. */
  const grid = advanced && gridOpen && !tool ? gridParams(gridFields) : null;
  /** `at` on the nearest of the grid's times, counted from the time shown as 0; as it is without them. */
  const gridAt = (at: number) => (grid?.step ? zero + Math.round((at - zero) / grid.step) * grid.step : at);
  /** `pos` on the nearest of the grid's depths; as it is without any. */
  const gridPos = (pos: number) => (grid?.positions.length ? grid.positions.reduce((a, b) => (Math.abs(b - pos) < Math.abs(a - pos) ? b : a)) : pos);
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

  /** Drag the bottom edge of the video to set its height; at most most of the window. */
  const dragVideoHeight = (e: PointerEvent<HTMLElement>) => dragHeight(e, videoHeight, setVideoHeight, VIDEO_MIN_HEIGHT);

  const { actions, chapters, bookmarks, regions } = script;
  /** The selected regions while in the script; they go with an edit that replaces them. */
  const chosen = regions.filter((r) => regionsOn.has(r));
  /** The selected region when it is all that is selected, which its panel shows. */
  const region = !selected.size && chosen.length === 1 ? chosen[0] : null;
  /** Whether there is something to copy: selected points, or a selected region with points. */
  const copyable = selected.size > 0 || chosen.some((r) => afterTime(actions, r.to) > byTime(actions, r.from));
  /** While the advanced editor is open, the main script's other points, in runs broken where its points were taken out; drawn faintly behind them, never edited. */
  const context = useMemo(() => {
    if (!advanced) return [];
    const from = new Set(advanced.from);
    const runs: Action[][] = [[]];
    main.actions.forEach((a, i) => (from.has(i) ? runs[runs.length - 1].length && runs.push([]) : runs[runs.length - 1].push(a)));
    return runs.filter((run) => run.length);
  }, [main.actions, advanced?.from]);
  /** The regions that stay while placing, with `kept`'s points: those in the lifted stretch go, and later ones move left as their points do. */
  const keptRegions = useMemo(() => {
    if (!lifted) return regions;
    const { from, to } = lifted;
    return regions.filter((r) => r.to < from || r.from > to).map((r) => (r.from > to ? movedBy(r, from - to) : r));
  }, [regions, lifted]);
  /**
   * The points that stay while placing: the lifted stretch's time goes, with
   * every point in it, and the later points move left by as much, as do the
   * regions after it; inserting it back there undoes it. A moved Markers
   * region's points go on the bookmarks in its new box.
   */
  const kept = useMemo(() => {
    if (!lifted) return actions;
    const { from, to } = lifted;
    const closed = [...actions.slice(0, byTime(actions, from)), ...actions.slice(afterTime(actions, to)).map((a) => ({ at: a.at - (to - from), pos: a.pos }))];
    const shifted = to > from ? markersRegions(keptRegions).filter((r) => r.from > from) : [];
    return shifted.reduce((list, r) => refilled(list, r, bookmarks), closed);
  }, [actions, lifted, keptRegions, bookmarks]);

  /** Undo history: the points, markers, regions and snippet library after each edit, the first as loaded; `index` is the current one. */
  const [timeline, setTimeline] = useState(() => startedAt(script, library, advanced ? "Open" : "Start"));
  /** The main script's undo history, put aside while the advanced editor is open; lost on a reload, when it starts over. */
  const mainTimeline = useRef<Timeline | null>(null);
  /** Set while a drag runs, so the whole drag becomes one edit when it ends; undo and redo wait for it. */
  const [dragging, setDragging] = useState(false);
  /** Change the script as an edit called `label`; in a drag, the whole drag is one edit, called as its last step. */
  const edit = (label: string, next: Parameters<typeof setScript>[0]) => {
    editLabel.current = label;
    setScript(next);
  };

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
    setTimeline((tl) => ({ ...tl, states: tl.states.map((st, k) => (k === tl.index ? { ...st, selection: { points: selected, regions: regionsOn, markers: marked } } : st)) }));
  }, [selected, regionsOn, marked, timeline.index, dragging, placing]);

  /** Go to the content and snippet library after edit `index` of the undo history, with the selection last made there, in selection mode with the box around it, and bring the change into view. */
  const jump = (index: number) => {
    const step = timeline.states[index];
    const { actions, chapters, bookmarks, regions, library } = step;
    const { points, regions: rs, markers } = step.selection ?? { points: new Set<number>(), regions: new Set<Region>(), markers: new Set<Marker>() };
    const span = changedSpan(script, step);
    setTimeline((tl) => ({ ...tl, index }));
    setTool(null);
    setScript((s) => ({ ...s, actions, chapters, bookmarks, regions }));
    setLibraryFile({ ossmRsWebTools: { version: 1, snippets: library } });
    setSelected(points);
    setRegionsOn(rs);
    setMarked(markers);
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

  /** Show `area` as the selection box and select the points and regions in it and in `base`. */
  const selectIn = (area: Area, base: { points: Iterable<number>; regions: Region[] } = { points: [], regions: [] }) => {
    setBox(area);
    select([...base.points, ...within(area)], [...base.regions, ...regionsIn(area)]);
  };

  /** `area` as selection mode's box, over every depth when selecting by time. */
  const boxed = (area: Area) => (selectByTime ? { ...area, low: 0, high: 100 } : area);

  /** The box around the points `ps` and the regions `rs`, over every depth for regions alone. */
  const boxAround = (ps: Action[], rs: Region[]): Area => {
    const area = ps.length ? ps.reduce(extended, spanned(ps[0], ps[0])) : { from: Infinity, to: -Infinity, low: 0, high: 100 };
    return { ...area, from: Math.min(area.from, ...rs.map((r) => r.from)), to: Math.max(area.to, ...rs.map((r) => r.to)) };
  };

  /**
   * Draw a box from the pointer and select the points and regions in it. In
   * selection mode the box replaces the selection and stays; otherwise (with
   * Shift) they add to it and the box goes when released. A click without
   * dragging is `click`, or clears the selection.
   */
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

  /**
   * Drag the `sides` of the selection box: an edge or corner resizes it, all
   * four move it. Only the points and regions in it are selected.
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
   * Lift the selection, the points `ps` and the regions `rs`, to place it
   * again: the stretch from its first to its last item, with every point and
   * region in it, the gap closing behind it, dragged by the point `grabbed`.
   * Returns its first point; null when it has none, as there is nothing to place.
   */
  const lift = (ps: number[], rs: Region[], grabbed?: number) => {
    const times = [...ps.map((i) => actions[i].at), ...rs.flatMap((r) => [r.from, r.to])];
    const [from, to] = [Math.min(...times), Math.max(...times)];
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

  /**
   * Follow a drag from `e` with what is being placed, its first point at
   * `start` as pressed; without one, once it has gone 3 px, with the
   * selection `ps`, `rs` lifted, by the point `grabbed`. Released, it goes in.
   */
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
   * Pick the item from `from` to `to` ms, a point or a region, clicked with
   * a modifier: Ctrl/Cmd toggles it in the selection with `toggle`, Shift
   * selects every point and region from the last clicked item to it. Returns
   * whether it did.
   */
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

  /** `set` with `item` in it if it wasn't, else without it. */
  const toggled = <T,>(item: T) => (set: Set<T>) => {
    const next = new Set(set);
    if (!next.delete(item)) next.add(item);
    return next;
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

  /** Select the markers `ms`, clearing the point selection. */
  const selectMarkers = (ms: Iterable<Marker>) => {
    setMarked(new Set(ms));
    setSelected(new Set());
    setBox(null);
  };
  const isChapter = (m: Marker): m is Chapter => chapters.includes(m as Chapter);
  const timeOf = (m: Marker) => (isChapter(m) ? m.start : m.time);

  /**
   * Add a bookmark at `time` ms, with the last used name, and select it.
   * Without one yet, it opens its name field; naming it is part of adding it.
   */
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
    track(timeRef.current!, e, move, () => setDragging(false), scrolls);
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
    setMarked(new Set());
  };

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

  /** Give the region `r` the name `name`. */
  const renameRegion = (r: Region, name: string) => {
    const renamed = isInstance(r) ? { ...r, snippet: { ...r.snippet, name } } : { ...r, name };
    edit(`Rename ${regionNoun(r)} to "${name}"`, (s) => ({ ...s, regions: s.regions.map((o) => (o === r ? renamed : o)) }));
    select([], [renamed]);
  };
  /** Close the name field with the accepted `name`, or null to keep the old one. */
  const closeNaming = (name: string | null) => {
    naming!.done(name);
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
  const canUndo = !dragging && (!!tool || timeline.index > 0);
  const canRedo = !dragging && (tool ? toolSteps.index < toolSteps.states.length - 1 : timeline.index < timeline.states.length - 1);
  // Else what is pending goes first, as with Escape: a drag in place, or what is being placed.
  const undo = () => (tool ? (toolSteps.index > 0 ? toolJump(toolSteps.index - 1) : setTool(null)) : discard() || (canUndo && jump(timeline.index - 1)));
  const redo = () => (tool ? canRedo && toolJump(toolSteps.index + 1) : discard() || (canRedo && jump(timeline.index + 1)));
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
    // One change in the tool's undo history.
    setDragging(true);
    track(e.currentTarget.ownerSVGElement!, e, (m) => move(pointerAt(m).at - origin, Math.round(((y0 - m.clientY) / height) * 100)), () => setDragging(false));
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

  /** Invert the selected points' depths, or all but the regions', at once as one edit, without opening a tool; not when it leaves them as they are. */
  const invert = () => {
    const picked = selected.size ? [...selected] : [...actions.keys()].filter((i) => !regionAt(regions, actions[i].at));
    if (picked.every((i) => actions[i].pos === 50)) return;
    const hit = new Set(picked);
    edit(`Invert ${points(picked.length)}`, (s) => ({ ...s, actions: s.actions.map((a, i) => (hit.has(i) ? { at: a.at, pos: 100 - a.pos } : a)) }));
    setSelected(hit);
  };

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
    if (key === "p" && !e.ctrlKey && !e.metaKey && videoUrl) return togglePlayer();
    if (tool && !((e.ctrlKey || e.metaKey) && (key === "z" || key === "y"))) return;
    if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "y")) {
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo();
      else undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      if (marked.size || overLane.current) selectMarkers(bookmarks);
      else select([...actions.keys()].filter((i) => !regionAt(regions, actions[i].at)), regions);
    } else if (e.key === "Escape") {
      // What is pending goes first, then the grid, then the selection.
      if (discard()) return;
      if (gridOpen) setGridOpen(false);
      else {
        select([]);
        setMarked(new Set());
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
    } else if ((e.key === "Delete" || e.key === "Backspace") && marked.size) {
      e.preventDefault();
      removeMarkers([...marked]);
    } else if (e.key === "F2" && marked.size) {
      e.preventDefault();
      rename([...marked]);
    } else if (e.key === "e" && !e.ctrlKey && !e.metaKey) {
      // With a region alone selected, edits it instead.
      if (region) editRegion(region);
      else openAdvanced();
    } else if (key === "b" && !e.ctrlKey && !e.metaKey && !markersLocked) {
      // At the playhead, or without media under the pointer.
      const at = videoUrl ? Math.round(time) : hoverAt.current;
      if (at !== null) addBookmark(at);
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

  /** Stop placing points; moved ones go back where they were, still selected, in selection mode with the box around them. */
  const cancelPlacing = () => {
    if (lifted) {
      select(lifted.points, lifted.regions);
      if (boxMode) setBox(boxed(boxAround([...lifted.points].map((i) => actions[i]), lifted.regions)));
    }
    setPlacing(null);
    setLifted(null);
  };

  /** Drop what is pending: the open tool, unapplied, else put back what is dragged in place, else stop placing; returns whether there was any. */
  const discard = () => {
    if (tool) setTool(null);
    else if (cancelApart.current) cancelApart.current();
    else if (placing) cancelPlacing();
    else return false;
    return true;
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
    setTimeline(startedAt({ ...doc, chapters, bookmarks }, library, "Open"));
    setAdvanced({ ...doc, zero, from, snippet, instance: instance && regions.indexOf(instance) });
    select([]);
    setMarked(new Set());
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

  /** What the undo history calls the library entry at `path`. */
  const entryNoun = (path: string[]) => {
    const e = entryAt(library, path);
    return e && isFolder(e) ? "folder" : "snippet";
  };

  /** Whether the folder at `folder` has an entry named `name`. */
  const nameTaken = (folder: string[], name: string) => itemsAt(shelf, folder).some((e) => entryName(e) === name);

  /** Save `clip` to the library as the snippet at `path`, timed from its first point, in place of one there. */
  const saveSnippet = (path: string[], clip: Clip) => {
    const name = path[path.length - 1];
    const snippet: Snippet = { name, ...clipBy(clip, -clip.actions[0].at) };
    setLibrary(`Save snippet "${name}"`, (lib) => updatedAt(lib, path.slice(0, -1), (items) => [...items.filter((e) => entryName(e) !== name), snippet]));
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

  /** Add an empty folder `name` at the top level. */
  const addFolder = (name: string) => setLibrary(`Add folder "${name}"`, (lib) => [...lib, { folder: name, items: [] }]);

  const renameEntry = (path: string[], name: string) => {
    const old = path[path.length - 1];
    setLibrary(`Rename ${entryNoun(path)} "${old}" to "${name}"`, (lib) => updatedAt(lib, path.slice(0, -1), (items) => items.map((e) => (entryName(e) !== old ? e : isFolder(e) ? { ...e, folder: name } : { ...e, name }))));
    reopened(path, [...path.slice(0, -1), name]);
  };

  /** Delete the entry at `path`, a folder with its contents. */
  const deleteEntry = (path: string[]) => {
    const name = path[path.length - 1];
    setLibrary(`Delete ${entryNoun(path)} "${name}"`, (lib) => updatedAt(lib, path.slice(0, -1), (items) => items.filter((o) => entryName(o) !== name)));
  };

  /** Of the entries at `from`, those not in the folder at `to` already. */
  const outside = (from: string[][], to: string[]) => from.filter((p) => JSON.stringify(p.slice(0, -1)) !== JSON.stringify(to));

  /** Whether the entries at `from` may go into the folder at `to`: not all there already, none into itself, none onto a name taken there or by another of them, and no preset nor into one. */
  const movable = (from: string[][], to: string[]) => {
    const names = outside(from, to).map((p) => p[p.length - 1]);
    return !!names.length && !isPreset(to) && !from.some(isPreset) && new Set(names).size === names.length && from.every((p) => !under(to, p)) && !names.some((n) => nameTaken(to, n));
  };

  /** Move the entries at `from` into the folder at `to`, the ones there already staying; selected there after. */
  const moveEntries = (from: string[][], to: string[]) => {
    const going = outside(from, to);
    const where = to.length ? `into "${to[to.length - 1]}"` : "to the top";
    setLibrary(going.length === 1 ? `Move ${entryNoun(going[0])} "${going[0][going[0].length - 1]}" ${where}` : `Move ${going.length} entries ${where}`, (lib) => {
      const es = going.map((p) => entryAt(lib, p)!);
      const left = going.reduce((l, p, k) => updatedAt(l, p.slice(0, -1), (items) => items.filter((o) => o !== es[k])), lib);
      return updatedAt(left, to, (items) => [...items, ...es]);
    });
    going.forEach((p) => reopened(p, [...to, p[p.length - 1]]));
    setRowsPicked(new Set(from.map((p) => JSON.stringify([...to, p[p.length - 1]]))));
  };

  /** A library row or the panel's top area as a place to drop the dragged rows into the folder at `to`, the top level for none; only in the main script. */
  const dropInto = (to: string[]) => advanced ? {} : {
    onPointerMove: () => rowDrag && movable(rowDrag.paths, to) && setDropOn(JSON.stringify(to)),
    onPointerLeave: () => setDropOn(null),
    onPointerUp: () => rowDrag && movable(rowDrag.paths, to) && moveEntries(rowDrag.paths, to),
  };

  /**
   * Pick the library row `key` clicked with a modifier: Ctrl/Cmd toggles it
   * in the selection, Shift selects the rows shown from the last clicked to
   * it, in `shown`, the rows shown by key in order.
   */
  const rowPicked = (e: PointerEvent, key: string, shown: string[]) => {
    if (e.shiftKey && rowAnchor.current && shown.includes(rowAnchor.current)) {
      const [i, j] = [shown.indexOf(rowAnchor.current), shown.indexOf(key)];
      return setRowsPicked(new Set(shown.slice(Math.min(i, j), Math.max(i, j) + 1)));
    }
    rowAnchor.current = key;
    setRowsPicked(toggled(key));
  };

  /**
   * Drag the library row of `entry` at `at` once the pointer moves from where
   * it was pressed, with the other selected rows if it is one: they go into
   * a folder row they are released on, and a lone snippet follows the pointer
   * onto the graph, as a paste, until released there or elsewhere. In the
   * main script, a press with Ctrl/Cmd or Shift picks the row instead, and
   * a click selects only it.
   */
  const dragRow = (e: PointerEvent, at: string[], entry: Entry, shown: string[]) => {
    if (e.button !== 0) return;
    const key = JSON.stringify(at);
    if (!advanced && (e.ctrlKey || e.metaKey || e.shiftKey)) return rowPicked(e, key, shown);
    // The selected entries still there, but those in a selected folder, which go with it.
    const picked = [...rowsPicked].map((k) => JSON.parse(k) as string[]).filter((p) => entryAt(shelf, p));
    const paths = !advanced && rowsPicked.has(key) ? picked.filter((p) => !picked.some((o) => o !== p && under(p, o))) : [at];
    if (!advanced && !rowsPicked.has(key)) setRowsPicked(new Set([key]));
    const [x, y] = [e.clientX, e.clientY];
    let started = false;
    const move = (m: globalThis.PointerEvent) => {
      if (!started && Math.hypot(m.clientX - x, m.clientY - y) < 4) return;
      if (!started) {
        cancelPlacing();
        if (paths.length === 1 && !isFolder(entry) && !tool) insertSnippet(entry);
      }
      started = true;
      setRowDrag({ paths, x: m.clientX, y: m.clientY, inPanel: !!(m.target as Element).closest?.("[data-aside]") });
    };
    // After the row or graph under the pointer has taken it.
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!started) {
        rowAnchor.current = key;
        if (!advanced) setRowsPicked(new Set([key]));
        return;
      }
      setRowDrag(null);
      setDropOn(null);
      setPlacing(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /** The library as a file: every snippet and folder. */
  const exportLibrary = () => download(libraryFile, "snippets.json");

  /** Merge a library file into the library: folders of the same name merge, a taken name gets " (2)"; malformed entries go. */
  const importLibrary = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { ossmRsWebTools?: { snippets?: unknown } } | null;
      if (!Array.isArray(parsed?.ossmRsWebTools?.snippets)) throw new Error();
      const read = readEntries(parsed.ossmRsWebTools.snippets);
      // A top-level name of a preset goes on as " (2)".
      setLibrary(`Import ${file.name}`, (lib) => merged([...PRESETS, ...lib], read).slice(PRESETS.length));
      setError(null);
    } catch {
      setError(`${file.name} is not a snippet library.`);
    }
  };

  /** Switch selection mode, not while placing. Entered with a selection, the box fits around it, selecting what is in it. */
  const toggleBoxMode = () => {
    if (placing) return;
    setBoxMode(!boxMode);
    if (!boxMode && (selected.size || chosen.length)) selectIn(boxed(boxAround([...selected].map((i) => actions[i]), chosen)));
    else setBox(null);
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
    const dp = keepDepth || regions.length || !depths.length ? 0 : clamp(gridPos(lead + pos - shape[0].pos) - lead, -Math.min(...depths), 100 - Math.max(...depths));
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
    const free = advanced && onMarkers ? bookmarks.filter((b) => !regionAt(keptRegions, b.time)) : [];
    if (free.length) return free.reduce((a, b) => (Math.abs(b.time - at) < Math.abs(a.time - at) ? b : a)).time;
    const lead = placing!.actions[placing!.grip ?? 0].at;
    return gridAt(at + lead) - lead;
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
    const times = pasted.length === 1 || (advanced && onMarkers) ? new Set(pasted.map((a) => a.at)) : null;
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
    if (boxMode) setBox(boxed(boxAround(own.map((j) => placed[j]), chosenCopies)), next);
    setPlacing(null);
    setLifted(null);
  };

  /** A click places what is being placed at the pointer, where it lands, unless refused there. */
  const place = (e: PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const [pasted, insert] = landedAt(e);
    if (pasted) put(pasted, insert);
  };

  /** What is being placed at the pointer where it lands, null where refused, and whether it would insert, by the modifiers held. */
  const landedAt = (e: { clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const point = pointerAt(e);
    const insert = !e.shiftKey;
    return [landing(positioned(snapAt(point.at), point.pos, e.ctrlKey || e.metaKey), insert), insert] as const;
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
      const opened = Array.from(parsed.at, (at, i) => ({ at, pos: parsed.pos[i] }));
      const markers = readMarkers(rest, Math.max(opened[opened.length - 1].at, videoDuration));
      // Taken as they are, never generated again.
      const regions = readRegions((rest.ossmRsWebTools as { regions?: unknown } | null | undefined)?.regions);
      const next = { name: file.name.replace(/\.funscript$/, ""), actions: opened, file: rest, ...markers, regions };
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

  /** The points being placed where the pointer puts them. */
  const ghost = placing && placeAt ? positioned(snapAt(placeAt.at), placeAt.pos, held.ctrl) : null;
  /** The point being placed or dragged apart dragged by, else the first, where it came from: a paste's depth alone, as it came from no time. */
  const dragged = placing && placeAt ? { at: placing.from === undefined ? undefined : placing.from + placing.actions[placing.grip ?? 0].at, pos: placing.actions[placing.grip ?? 0].pos } : apart?.grip;
  /** Where they go in; none where they can't, as they would cut into a region, and they show red. */
  const landed = ghost && landing(ghost, inserting);
  const refused = !!ghost && !landed;
  /** As they would go in, and the script around them, drawn so. */
  const going = landed && goingIn(landed);
  const dropped = landed && around(landed, inserting);
  /** The points as drawn: placing, as they would be once placed. */
  const shown = going && dropped ? [...dropped.before, ...going.placed, ...dropped.after] : preview?.actions ?? kept;
  /** The regions as drawn, with the points. */
  const shownRegions = going && dropped ? [...dropped.regions, ...going.carried] : preview?.regions ?? keptRegions;
  /** The selected points as drawn: placing, the picked ones; with a tool open, the affected ones in its result. */
  const marks = going && dropped ? new Set(going.points.map((j) => dropped.before.length + j)) : preview?.selected ?? selected;
  /** Whether the region `r` is drawn selected: a selected one, or a picked one being placed. */
  const outlined = (r: Region) => regionsOn.has(r) || !!going?.regions.includes(r);
  /** Where they can't go in, their points and the time they cover there, drawn red over the rest. */
  const astray = refused ? { points: filledIn(ghost), span: spanOf(ghost) } : null;
  /** Replacing, the line through the points they would take out, from the point before to the one after, drawn faint red and dashed, as removed points in the undo history. */
  const removed = landed && !inserting ? (() => {
    const [start, end] = spanOf(landed);
    const [lo, hi] = [byTime(kept, start), afterTime(kept, end)];
    return lo < hi ? kept.slice(Math.max(lo - 1, 0), hi + 1) : null;
  })() : null;

  // A drag's release, or Done, goes in once rendered with where it lands; refused there, a drag goes back, and Done's result follows the pointer as a paste.
  useEffect(() => {
    if (!settle) return;
    setSettle(null);
    if (landed) put(landed, inserting);
    else if (settle === "drop") cancelPlacing();
  }, [settle]);

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
    // With a tool open, the points it was opened on, faint and dashed behind its result; Repeat's only in its pattern box. Moving, the lifted points where they were, alike.
    if (tool || lifted) {
      ctx.save();
      Object.assign(ctx, { lineWidth: 1.5, strokeStyle: css.getPropertyValue("--gray-a9") });
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      const all = tool?.actions ?? actions;
      const a = !tool ? all.slice(byTime(all, lifted!.from), afterTime(all, lifted!.to))
        : tool.kind !== "repeat" ? all : repParams ? all.slice(byTime(all, repBox.from), afterTime(all, repBox.from + repParams.length)) : [];
      // A moved region shows only its dashed outline, not its points' line.
      const moved = tool ? [] : regions.filter((r) => r.from >= lifted!.from && r.to <= lifted!.to);
      let prev: Action | undefined;
      for (const p of a.slice(Math.max(byTime(a, view.from) - 1, 0), byTime(a, view.from + view.span) + 1)) {
        const r = regionAt(moved, p.at);
        if (r && prev && regionAt(moved, prev.at) === r) ctx.moveTo(x(p.at), y(p.pos));
        else ctx.lineTo(x(p.at), y(p.pos));
        prev = p;
      }
      // A lone point, which makes no line, as a ring; but a region's, whose band shows.
      if (!tool && a.length === 1 && !regionAt(regions, a[0].at)) ctx.arc(x(a[0].at), y(a[0].pos), 5, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.restore();
    }
    // Moved in place, the line as it was where it went through them, from the points either side, dashed alike.
    if (apart) {
      const { actions: was, moving, regions: moved } = apart;
      ctx.save();
      Object.assign(ctx, { lineWidth: 1.5, strokeStyle: css.getPropertyValue("--gray-a9") });
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let j = Math.max(byTime(was, view.from), 1); j < Math.min(byTime(was, view.from + view.span) + 1, was.length); j++) {
        if (!moving.has(j - 1) && !moving.has(j)) continue;
        const r = regionAt(moved, was[j].at);
        if (r && regionAt(moved, was[j - 1].at) === r) continue;
        ctx.moveTo(x(was[j - 1].at), y(was[j - 1].pos));
        ctx.lineTo(x(was[j].at), y(was[j].pos));
      }
      ctx.stroke();
      ctx.restore();
    }
    if (removed) {
      ctx.save();
      Object.assign(ctx, { globalAlpha: 0.35, lineWidth: 2, strokeStyle: css.getPropertyValue("--red-9") });
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (const a of removed.slice(Math.max(byTime(removed, view.from) - 1, 0), byTime(removed, view.from + view.span) + 1)) ctx.lineTo(x(a.at), y(a.pos));
      ctx.stroke();
      ctx.restore();
    }
    Object.assign(ctx, { strokeStyle: LINE_COLOR, fillStyle: LINE_COLOR });
    // Repeat's copies show thin and faded, so its pattern's line stands out; the line breaks between them, to be drawn over.
    const muted = tool?.kind === "repeat" && !ghost;
    // A selected region's line shows as the selected points', as does the line joining it to a selected point or region next to it.
    const lit = tool ? [] : shownRegions.filter(outlined);
    const on = (j: number) => j >= 0 && (marks.has(first + j) || !!regionAt(lit, visible[j].at));
    const between = (j: number) => on(j - 1) && on(j);
    ctx.beginPath();
    visible.forEach((a, j) => (muted && between(j) ? ctx.moveTo(x(a.at), y(a.pos)) : ctx.lineTo(x(a.at), y(a.pos))));
    ctx.stroke();
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
      if (!between(j)) continue;
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
    // One path per look, so drawing stays fast however many points there are.
    const [dots, ringed] = [new Path2D(), new Path2D()];
    visible.forEach((a, j) => {
      const [cx, cy] = [x(a.at), y(a.pos)];
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
    // Where the points being placed can't go in, they show red over the rest; only those in view, as a selection to move can be the whole script.
    if (astray) {
      const { points } = astray;
      const red = css.getPropertyValue("--red-9");
      ctx.save();
      Object.assign(ctx, { globalAlpha: 0.6, lineWidth: 2, strokeStyle: red, fillStyle: red });
      ctx.beginPath();
      const [l0, l1] = [Math.max(byTime(points, view.from) - 1, 0), Math.min(byTime(points, view.from + view.span) + 1, points.length)];
      for (let j = l0; j < l1; j++) ctx.lineTo(x(points[j].at), y(points[j].pos));
      ctx.stroke();
      const redDots = new Path2D();
      const carried = carriedBy(ghost!);
      for (const a of points.slice(l0, l1)) {
        if (regionAt(carried, a.at)) continue;
        redDots.moveTo(x(a.at) + 5, y(a.pos));
        redDots.arc(x(a.at), y(a.pos), 5, 0, 2 * Math.PI);
      }
      ctx.fill(redDots);
      ctx.restore();
    }
  });
  /** The selection box's sides, in px. */
  const edges = box && { from: x(box.from), to: x(box.to), low: y(box.low), high: y(box.high) };
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

  /**
   * The library's rows in the folder at `path`, `depth` deep, an open
   * folder's rows after it, each added to `shownRows`. In the main script
   * rows are selected, and dragged onto a folder row to move them there, and
   * a row but a preset's has Rename and Delete, a snippet's also Edit.
   * Everywhere a snippet's row is dragged onto the graph to insert it.
   */
  const shownRows: string[] = [];
  const libraryRows = (items: Entry[], path: string[], depth: number): ReactElement[] => sortedEntries(items).flatMap((e) => {
    const [name, at] = [entryName(e), [...path, entryName(e)]];
    const key = JSON.stringify(at);
    shownRows.push(key);
    const open = isFolder(e) && (!!snippetQuery || openFolders.includes(key));
    const toggle = () => setOpenFolders((keys) => (open ? keys.filter((k) => k !== key) : [...keys, key]));
    const row = (
      <Flex
        key={key}
        align="center"
        gap="1"
        data-library-row
        onPointerDown={!advanced || !isFolder(e) ? (p) => dragRow(p, at, e, shownRows) : undefined}
        {...(isFolder(e) ? dropInto(at) : {})}
        style={{ paddingLeft: depth * 16, minHeight: 28, borderRadius: 4, userSelect: "none", background: dropOn === key ? "var(--accent-a4)" : !advanced && rowsPicked.has(key) ? "var(--accent-a3)" : undefined }}
      >
        {/* A snippet's name shows a preview beside the panel: its points, its regions' boxes behind, and their stats. */}
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
              {isFolder(e) ? <ChevronRightIcon style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined }} /> : <SnippetIcon style={{ flexShrink: 0 }} />}
              <Text size="2" truncate>{name}</Text>
            </Flex>
          </HoverCard.Trigger>
          {!isFolder(e) && (
            <HoverCard.Content side="left" size="1">
              <Flex direction="column" gap="3">
                <PreviewGraph pieces={[{ kind: "plain", points: e.actions }]} bands={generators(e.regions)} />
                <Stats actions={e.actions} picked={[...e.actions.keys()]} size="1" />
              </Flex>
            </HoverCard.Content>
          )}
        </HoverCard.Root>
        {!advanced && !isPreset(at) && !isFolder(e) && (
          <IconButton size="1" variant="ghost" color="gray" disabled={!!placing} aria-label="Edit" title="Edit it in the advanced editor" onClick={() => openAdvanced({ path: at })}><MixerHorizontalIcon /></IconButton>
        )}
        {!advanced && !isPreset(at) && <>
          <NamePopover initial={name} taken={(n) => n !== name && nameTaken(path, n)} onName={(n) => n !== name && renameEntry(at, n)}>
            <IconButton size="1" variant="ghost" color="gray" aria-label="Rename" title="Rename"><Pencil1Icon /></IconButton>
          </NamePopover>
          <IconButton size="1" variant="ghost" color="red" aria-label="Delete" title={isFolder(e) ? "Delete it with its contents" : "Delete"} onClick={() => deleteEntry(at)}><TrashIcon /></IconButton>
        </>}
      </Flex>
    );
    return [row, ...(open ? libraryRows((e as Folder).items, at, depth + 1) : [])];
  });

  const shownLibrary = snippetQuery ? matching(shelf, snippetQuery) : shelf;
  /** The Snippets panel, beside the graph: the library as a tree; in the main script, its top area takes rows dropped to the top level. */
  const snippetsPanel = <Flex direction="column" gap="3" p="3">
    <Flex direction="column" gap="2" {...dropInto([])} style={{ borderRadius: 4, background: dropOn === "[]" ? "var(--accent-a4)" : undefined }}>
      <Text size="2" weight="medium">Snippets</Text>
      {!advanced && <Flex gap="2" wrap="wrap">
        <Button size="1" variant="soft" color="gray" disabled={!!placing} title="Make a snippet in the advanced editor" onClick={() => openAdvanced({ path: null })}>
          <PlusIcon /> New snippet
        </Button>
        <NamePopover taken={(n) => nameTaken([], n)} onName={addFolder}>
          <Button size="1" variant="soft" color="gray"><PlusIcon /> New folder</Button>
        </NamePopover>
        <Button size="1" variant="soft" color="gray" disabled={!library.length} title="Save the library to a file" onClick={exportLibrary}>
          <DownloadIcon /> Export
        </Button>
        <Button size="1" variant="soft" color="gray" title="Merge a library file into the library" onClick={() => libraryInput.current?.click()}>
          <UploadIcon /> Import
        </Button>
      </Flex>}
      {!!shelf.length && (
        <TextField.Root size="1" placeholder="Search" aria-label="Search snippets" value={snippetQuery} onChange={(e) => setSnippetQuery(e.target.value)}>
          <TextField.Slot><MagnifyingGlassIcon /></TextField.Slot>
        </TextField.Root>
      )}
    </Flex>
    <Flex direction="column">
      {shownLibrary.length ? libraryRows(shownLibrary, [], 0) : <Text size="1" color="gray">{shelf.length ? "No matches." : "No snippets yet."}</Text>}
    </Flex>
    {/* The dragged row's icon and name follow the pointer; for several, the first's icon and their count. Outside the panel, where nothing takes them, the cursor says so. */}
    {rowDrag && !rowDrag.inPanel && !placing && <style>{"* { cursor: not-allowed !important; }"}</style>}
    {rowDrag && (
      <Flex align="center" gap="2" style={{ position: "fixed", left: rowDrag.x + 12, top: rowDrag.y + 12, pointerEvents: "none", zIndex: 1 }}>
        {entryAt(shelf, rowDrag.paths[0]) && isFolder(entryAt(shelf, rowDrag.paths[0])!) ? <ChevronRightIcon /> : <SnippetIcon />}
        <Text size="2">{rowDrag.paths.length > 1 ? `${rowDrag.paths.length} entries` : rowDrag.paths[0][rowDrag.paths[0].length - 1]}</Text>
      </Flex>
    )}
  </Flex>;

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
    seek(t);
  };

  /**
   * The Markers panel, beside the graph: the chapters and bookmarks in time,
   * the selected ones marked. A click on one shows it, and selects it;
   * bookmarks are selected together as on the lane. A double-click renames
   * it. The advanced editor's document has no markers of its own, so there
   * they only show their times, unless its lane is unlocked.
   */
  const markerRow = (m: Marker, key: string) => (
    <Flex
      key={key}
      align="center"
      gap="2"
      px="1"
      onClick={(e) => {
        if (!markersLocked && markerPicked(e, m)) return;
        if (!markersLocked) {
          markerAnchor.current = m;
          selectMarkers([m]);
        }
        goTo(timeOf(m));
      }}
      onDoubleClick={() => !markersLocked && rename([m])}
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
            if (!discardable()) return;
            setLifted(null);
            setSelected(new Set());
            setMarked(new Set());
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
      <SpeedCalculator actions={actions} picked={statsPicked} selectionOn={selected.size > 0 || chosen.length > 0} />
      </>}
      {/* In the main script, only a region's Generate. */}
      {(advanced || tool) && <>
        {advanced && !tool && !gridOpen && <Separator size="4" />}
        {!tool && !gridOpen ? <>
          {/* The tools, on the selected points or all but the regions', each with a small graph of what it does; Generate needs none, Repeat a pattern of two selected. */}
          <Text size="2" weight="medium">Tools</Text>
          {TOOLS.map(({ kind, name, before, after }) => (
            <Button
              key={kind}
              variant="soft"
              color="gray"
              disabled={(kind === "repeat" ? selected.size < 2 : kind !== "generate" && kind !== "grid" && actions.every((a) => regionAt(regions, a.at))) || !!placing}
              title={kind === "repeat" ? "Repeat the selected points, two or more" : kind === "grid" ? "Snap points to a grid while it is open" : undefined}
              onClick={() => (kind === "invert" ? invert() : kind === "grid" ? setGridOpen(true) : openTool(kind))}
              style={{ justifyContent: "flex-start" }}
            >
              <svg width="56" height="24" viewBox="0 0 56 24" fill="none" strokeWidth={1.5} strokeLinejoin="round">
                <polyline points={before} style={{ stroke: "var(--gray-8)" }} />
                <polyline points={after} stroke={LINE_COLOR} />
              </svg>
              {name}
            </Button>
          ))}
        </> : tool ? <>
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
        </> : <>
          {/* The grid, without Apply: editing goes on while it is open. Escape in its fields closes it too, as a tool's. */}
          <Flex gap="2" align="center">
            <IconButton size="1" variant="ghost" color="gray" aria-label="Back to the tools" title="Back to the tools (Escape)" onClick={() => setGridOpen(false)}>
              <ArrowLeftIcon />
            </IconButton>
            <Text size="2" weight="medium">Grid</Text>
          </Flex>
          <Text size="1" color="gray">Points added, dragged and placed go to the nearest line. Leave a field empty to not snap that way.</Text>
          <Flex direction="column" gap="2" onKeyDown={(e) => e.key === "Escape" && setGridOpen(false)}>
            <TextField.Root type="number" min={0} step="any" aria-label="Time interval" value={gridFields.time} onChange={(e) => setGridFields({ ...gridFields, time: e.target.value })}>
              <TextField.Slot side="left">Time every</TextField.Slot>
              <TextField.Slot side="right">s</TextField.Slot>
            </TextField.Root>
            <TextField.Root type="number" min={0} step="any" aria-label="Depth interval" value={gridFields.depth} onChange={(e) => setGridFields({ ...gridFields, depth: e.target.value })}>
              <TextField.Slot side="left">Depth every</TextField.Slot>
            </TextField.Root>
            <TextField.Root aria-label="Depths" placeholder="33, 66" title="Depths of their own, apart by commas" value={gridFields.depths} onChange={(e) => setGridFields({ ...gridFields, depths: e.target.value })}>
              <TextField.Slot side="left">Depths</TextField.Slot>
            </TextField.Root>
          </Flex>
        </>}
      </>}
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

  /** Whether the time from `from` to `to` is in view, to draw only the markers there. */
  const inView = (from: number, to: number) => to >= view.from && from <= view.from + view.span;

  const light = lightChapters(chapters);

  /** The point labelled with its time and position: the one dragged by while moving, else the selected point when there is just one. */
  const labelled = (placing?.grip !== undefined && landed ? landed[placing.grip] : apart?.now) ?? (marks.size === 1 ? shown[[...marks][0]] : undefined);

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
                          const regionsChanged = before.regions !== state.regions;
                          // A change only to the snippet library has nothing to show but its label.
                          const others = markersChanged || regionsChanged || before.library !== state.library;
                          return <>
                            {(before.actions !== state.actions || !others) && <PreviewGraph pieces={diffPieces(before.actions, state.actions)} />}
                            {markersChanged && <LanePreview lists={[[before.chapters.map(chapterItem), state.chapters.map(chapterItem)], [before.bookmarks.map(bookmarkItem), state.bookmarks.map(bookmarkItem)]]} />}
                            {regionsChanged && <LanePreview lists={[[before.regions.map(regionItem), state.regions.map(regionItem)]]} />}
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
            {videoUrl && (
              <g onPointerDown={dragPlayhead} style={{ cursor: "ew-resize" }}>
                {/* A wider, invisible line to grab. */}
                <line x1={x(time)} x2={x(time)} y1={0} y2={plotHeight} strokeWidth={12} stroke="transparent" />
                <line x1={x(time)} x2={x(time)} y1={0} y2={plotHeight} strokeWidth={2} style={{ stroke: "var(--gray-12)" }} />
                <path d={`M${x(time) - 6},0 h12 l-6,8 z`} style={{ fill: "var(--gray-12)" }} />
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
            {/* Kept in the SVG, so the line and points stay between what is drawn under and over them. */}
            <foreignObject width={width} height={height} style={{ pointerEvents: "none" }}>
              <canvas ref={canvasRef} style={{ display: "block", width, height }} />
            </foreignObject>
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
        {/* In the advanced editor, its lock beside it, where the lane stops short of the graph's end. */}
        {/* The locked lane takes no pointer, so its hover shows this, the lock its own. */}
        <Flex gap="2" flexShrink="0" title={markersLocked ? "Unlock to edit" : undefined}>
          <Box
            position="relative"
            flexGrow="1"
            height={`${LANE_HEIGHT}px`}
            onPointerDown={laneDown}
            onPointerEnter={() => void (overLane.current = true)}
            onPointerLeave={() => void (overLane.current = false)}
            // The advanced editor's document has no markers, so the lane takes no presses there until unlocked.
            style={{ borderRadius: 6, background: "var(--gray-a2)", overflow: "hidden", userSelect: "none", touchAction: "none", cursor: "crosshair", pointerEvents: markersLocked ? "none" : undefined }}
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
            {/* Suggests the names in the script. */}
            {naming && (
              <NamePopover
                initial={naming.name}
                anchor={{ position: "absolute", left: Math.max(x(naming.from), 0), width: Math.min(x(naming.to), width) - Math.max(x(naming.from), 0), height: "100%", pointerEvents: "none" }}
                suggestions={[...new Set([...chapters, ...bookmarks].map((m) => m.name))]}
                onName={(name) => closeNaming(name)}
                onCancel={() => closeNaming(null)}
                onRemove={naming.remove && (() => {
                  naming.remove!();
                  setNaming(null);
                })}
              />
            )}
          </Box>
          {advanced && (
            <IconButton
              variant="soft"
              color="gray"
              aria-pressed={markersUnlocked}
              aria-label={markersUnlocked ? "Lock markers" : "Unlock markers"}
              title={markersUnlocked ? "Lock the markers" : "Unlock the markers, to edit the main script's chapters and bookmarks here"}
              onClick={() => {
                setMarkersUnlocked(!markersUnlocked);
                setMarked(new Set());
              }}
              style={{ width: LANE_HEIGHT, height: LANE_HEIGHT }}
            >
              {markersUnlocked ? <LockOpen1Icon /> : <LockClosedIcon />}
            </IconButton>
          )}
        </Flex>
      </Flex>
      {minimap ? (
        <Minimap
          width={width}
          total={total}
          view={view}
          setView={setView}
          actions={actions}
          kept={kept}
          selected={selected}
          chapters={chapters}
          bookmarks={bookmarks}
          regions={[...(advanced ? main.regions : []), ...regions]}
          context={advanced ? context : null}
          playheadAt={videoUrl ? time : null}
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
    {asideTab === "markers" ? markersPanel : snippetsPanel}
  </Flex>;

  return <GraphLayout sidebar={sidebar} content={content} aside={asideShown && asidePanel} />;
}
