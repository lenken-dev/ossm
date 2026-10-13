import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { Box, Button, Callout, Flex, HoverCard, IconButton, Popover, Separator, Slider, Switch, Text, TextField, useThemeContext } from "@radix-ui/themes";
import { ClipboardIcon, ColumnSpacingIcon, CopyIcon, MoveIcon, ResetIcon, CounterClockwiseClockIcon, Cross2Icon, Crosshair2Icon, DownloadIcon, ExclamationTriangleIcon, FileIcon, GearIcon, HeightIcon, OpenInNewWindowIcon, PauseIcon, PlayIcon, ScissorsIcon, TrackNextIcon, TrackPreviousIcon, UploadIcon, VideoIcon } from "@radix-ui/react-icons";
import { bisector } from "d3";
import { usePersistedState } from "../hooks/usePersistedState";
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
}

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

/** The selection box's edges, then its corners on top, as the sides dragging them changes. */
const GRIPS = [["from", null], ["to", null], [null, "high"], [null, "low"], ["from", "high"], ["to", "high"], ["from", "low"], ["to", "low"]] as const;
/** Size of the selection box's grips, in px. */
const GRIP = 8;

const EMPTY: Script = { name: "untitled", actions: [] };

/** Copies kept in the clipboard history. */
const HISTORY_SIZE = 10;
/** Edits kept for undo. */
const UNDO_SIZE = 100;

/** Visible time range, in ms; at most the script or the video, whichever is longer, but at least the floor. */
const MIN_SPAN = 500;
const MAX_SPAN_FLOOR = 10_000;
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

/** Height of the minimap that shows the whole script below the graph, in px. */
const MINIMAP_HEIGHT = 40;

/** Default and smallest height of the reference video, in px. */
const VIDEO_HEIGHT = 300;
const VIDEO_MIN_HEIGHT = 80;
/** Where the playhead stays in view while the video plays, as a fraction of the visible time. */
const FOLLOW_AT = 0.2;
/** Time steps of the seek buttons, in s, as typed; the first is always shown, empty ones are hidden. */
const DEFAULT_STEPS = ["1", "", ""];

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const byTime = bisector((a: Action) => a.at).left;
const points = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;

export default function EditorPage() {
  // Kept across reloads, so switching tabs or closing the page does not lose the work.
  const [script, setScript] = usePersistedState<Script>("ossm:editorScript", EMPTY, localStorage);
  const [view, setView] = usePersistedState("ossm:editorView", { from: 0, span: 10_000 });
  const [error, setError] = useState<string | null>(null);
  /** Indices of the selected points, moved together and deleted with the Delete key. */
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  /**
   * Selection mode: dragging on empty space draws a box that selects points
   * instead of adding one, and the box stays to be resized or moved; only the
   * points in it are selected. Otherwise Shift draws one that goes when released.
   */
  const [boxMode, setBoxMode] = useState(false);
  /** Pasted points, timed from the first, that follow the pointer until a click places them. */
  const [placing, setPlacing] = useState<Action[] | null>(null);
  /** The selected points being placed again, left out of the script until placed; Escape puts them back. */
  const [lifted, setLifted] = useState<Set<number> | null>(null);
  /** Where the first point being placed is, under the pointer. */
  const [placeAt, setPlaceAt] = useState<Action | null>(null);
  /** Placing inserts, moving later points right, instead of replacing the points the pasted ones cover. */
  const [insertMode, setInsertMode] = usePersistedState("ossm:editorInsert", false, localStorage);
  /** Selection mode's box selects by time: it takes in whole stretches of the script, whatever their depth. */
  const [selectByTime, setSelectByTime] = usePersistedState("ossm:editorSelectByTime", false, localStorage);
  /**
   * Modifiers held while placing: Shift switches to the other mode, Ctrl (or
   * Cmd) keeps the copied depths instead of following the pointer's.
   */
  const [held, setHeld] = useState({ shift: false, ctrl: false });
  const inserting = insertMode !== held.shift;
  /** The latest copies, newest first; for this visit to the page. */
  const [history, setHistory] = useState<Action[][]>([]);
  /** The selection box; it goes when the points change. */
  const [box, setBox] = useState<Area | null>(null);
  /** The point last clicked without Shift, where a Shift+click range starts. */
  const anchor = useRef<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
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
  const [videoHeight, setVideoHeight] = pip ? [pipHeight, setPipHeight] : [normalHeight, setNormalHeight];
  /** A minimap of the whole script to scroll with, instead of the slider. */
  const [minimap, setMinimap] = usePersistedState("ossm:editorMinimap", true, localStorage);
  const [steps, setSteps] = usePersistedState("ossm:editorSteps", DEFAULT_STEPS, localStorage);
  /** The steps in use; a first step that is not a positive number falls back to the default. */
  const shownSteps = steps.map(Number).map((v, i) => (v > 0 ? v : i === 0 ? Number(DEFAULT_STEPS[0]) : null)).filter((v) => v !== null);
  /** Video time, in ms. */
  const [time, setTime] = useState(0);
  /** Video length, in ms; 0 without one. */
  const [videoDuration, setVideoDuration] = useState(0);
  const end = script.actions.length ? script.actions[script.actions.length - 1].at : 0;
  const maxSpan = Math.max(end, videoDuration, MAX_SPAN_FLOOR);
  const spanStep = SPAN_STEPS.find((s) => s * SPAN_STEP_COUNT >= maxSpan / 1000) ?? SPAN_STEPS[SPAN_STEPS.length - 1];

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
  const dragVideoHeight = (e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const start = videoHeight;
    const target = e.currentTarget;
    const startY = e.clientY;
    const move = (m: globalThis.PointerEvent) =>
      setVideoHeight(Math.round(Math.min(Math.max(start + (m.clientY - startY), VIDEO_MIN_HEIGHT), window.innerHeight * 0.7)));
    target.setPointerCapture(e.pointerId);
    target.addEventListener("pointermove", move);
    target.addEventListener("lostpointercapture", () => target.removeEventListener("pointermove", move), { once: true });
  };

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(boxRef.current!);
    return () => observer.disconnect();
  }, []);

  // The wheel scrolls through time, with Ctrl it zooms around the pointer. Not passive, to keep the page from scrolling.
  useEffect(() => {
    const el = boxRef.current!;
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

  const { actions } = script;
  useEffect(() => setBox(null), [actions]);
  /** The points that stay while placing. */
  const kept = lifted ? actions.filter((_, i) => !lifted.has(i)) : actions;

  /** Undo history: the points after each edit, the first as loaded; `index` is the current one. */
  const [timeline, setTimeline] = useState(() => ({ states: [{ actions, label: "Start" }], index: 0 }));
  /** Set while a drag runs, so the whole drag becomes one edit when it ends. */
  const dragging = useRef(false);
  const [dragEnds, setDragEnds] = useState(0);
  /** What the next edit is called in the undo history. */
  const editLabel = useRef<string | null>(null);

  // Every change of the points, except by undo and redo, is an edit.
  useEffect(() => {
    if (dragging.current) return;
    const label = editLabel.current ?? "Edit";
    editLabel.current = null;
    setTimeline((tl) => {
      if (tl.states[tl.index].actions === actions) return tl;
      const states = [...tl.states.slice(0, tl.index + 1), { actions, label }].slice(-UNDO_SIZE - 1);
      return { states, index: states.length - 1 };
    });
  }, [actions, dragEnds]);

  /** Go to the points after edit `index` of the undo history. */
  const jump = (index: number) => {
    setTimeline((tl) => ({ ...tl, index }));
    setScript((s) => ({ ...s, actions: timeline.states[index].actions }));
    setSelected(new Set());
    setPlacing(null);
    setLifted(null);
  };
  /** The points as last saved, opened or started anew; unknown after a reload with unsaved changes. */
  const [unsaved, setUnsaved] = usePersistedState("ossm:editorUnsaved", false, localStorage);
  const [saved, setSaved] = useState<Action[] | null>(() => (unsaved ? null : actions));
  useEffect(() => setUnsaved(actions !== saved), [actions, saved, setUnsaved]);
  useWindowEvent("beforeunload", (e) => {
    if (actions !== saved) e.preventDefault();
  });
  const canUndo = timeline.index > 0;
  const canRedo = timeline.index < timeline.states.length - 1;
  const undo = () => canUndo && jump(timeline.index - 1);
  const redo = () => canRedo && jump(timeline.index + 1);
  const plotHeight = height - AXIS;
  const x = (at: number) => ((at - view.from) / view.span) * width;
  const y = (pos: number) => PAD + (1 - pos / 100) * (plotHeight - 2 * PAD);
  /** The script time and position under the pointer. */
  const pointerAt = (e: { clientX: number; clientY: number }) => {
    const rect = boxRef.current!.getBoundingClientRect();
    return {
      at: Math.round(view.from + ((e.clientX - rect.left) / width) * view.span),
      pos: Math.round(clamp(100 - ((e.clientY - rect.top - PAD) / (plotHeight - 2 * PAD)) * 100, 0, 100)),
    };
  };

  /**
   * Drag the points `indices` together. They keep their spacing, stay within
   * 0–100 and between their unselected neighbours, so the actions stay sorted.
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
    const move = (m: globalThis.PointerEvent) => {
      const p = pointerAt(m);
      setScript((s) => {
        const a = (start ??= s.actions);
        let [dtMin, dtMax, dpMin, dpMax] = [-Infinity, Infinity, -100, 100];
        for (const i of indices) {
          dtMin = Math.max(dtMin, -a[i].at, i > 0 && !moving.has(i - 1) ? a[i - 1].at + 1 - a[i].at : -Infinity);
          dtMax = Math.min(dtMax, i < a.length - 1 && !moving.has(i + 1) ? a[i + 1].at - 1 - a[i].at : Infinity);
          dpMin = Math.max(dpMin, -a[i].pos);
          dpMax = Math.min(dpMax, 100 - a[i].pos);
        }
        const dt = clamp(p.at - origin.at, dtMin, dtMax);
        const dp = clamp(p.pos - origin.pos, dpMin, dpMax);
        const next = a.slice();
        for (const i of indices) next[i] = { at: a[i].at + dt, pos: a[i].pos + dp };
        return { ...s, actions: next };
      });
    };
    svg.setPointerCapture(e.pointerId);
    svg.addEventListener("pointermove", move as EventListener);
    svg.addEventListener("lostpointercapture", () => {
      svg.removeEventListener("pointermove", move as EventListener);
      dragging.current = false;
      setDragEnds((n) => n + 1);
    }, { once: true });
  };

  /** The indices of the points in `area`. */
  const within = (area: Area) => {
    const found = [];
    for (let i = byTime(actions, area.from); i < actions.length && actions[i].at <= area.to; i++) {
      if (actions[i].pos >= area.low && actions[i].pos <= area.high) found.push(i);
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
    svg.setPointerCapture(e.pointerId);
    svg.addEventListener("pointermove", move);
    svg.addEventListener("lostpointercapture", () => {
      svg.removeEventListener("pointermove", move);
      if (!moved || !keep) setBox(null);
      if (!moved) setSelected(new Set());
    }, { once: true });
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
    svg.setPointerCapture(e.pointerId);
    svg.addEventListener("pointermove", move);
    svg.addEventListener("lostpointercapture", () => svg.removeEventListener("pointermove", move), { once: true });
  };

  /** Add a point under the pointer and keep dragging it; with several points selected, only clear the selection. */
  const add = (e: PointerEvent<SVGSVGElement>) => {
    const hit = pointUnder(e);
    if (hit !== null) return pointDown(e, hit);
    if (e.button !== 0) return;
    if (boxMode || e.shiftKey) {
      boxSelect(e);
      return;
    }
    if (selected.size > 1) {
      setSelected(new Set());
      return;
    }
    const point = pointerAt(e);
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
   * Ctrl/Cmd+click toggles a point in the selection, Shift+click selects the
   * range from the last clicked point. A plain click selects the point, or
   * keeps the selection it is in, and drags. In selection mode, Ctrl/Cmd or
   * Shift+click grows the box to take in the point.
   */
  const pointDown = (e: PointerEvent<Element>, i: number) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      if (boxMode) {
        selectIn(boxed(extended(box ?? spanned(actions[i], actions[i]), actions[i])));
        return;
      }
      if (e.shiftKey) {
        // The anchor may be past the end after deleting points.
        const from = Math.min(anchor.current ?? i, actions.length - 1);
        setSelected(new Set(Array.from({ length: Math.abs(i - from) + 1 }, (_, k) => Math.min(i, from) + k)));
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
    target.setPointerCapture(e.pointerId);
    target.addEventListener("pointermove", move as EventListener);
    target.addEventListener("lostpointercapture", () => {
      target.removeEventListener("pointermove", move as EventListener);
      if (wasPlaying) void media.play();
    }, { once: true });
  };

  /** The time the minimap shows: the script, the video and the visible time, whichever is longest. */
  const total = Math.max(end, videoDuration, view.span);
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

  const removeSelected = (verb = "Delete") => {
    editLabel.current = `${verb} ${points(selected.size)}`;
    setScript((s) => ({ ...s, actions: s.actions.filter((_, j) => !selected.has(j)) }));
    setSelected(new Set());
  };

  // Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z or Ctrl+Y redoes. Ctrl/Cmd+A selects all points, Escape none, Delete (or Backspace, the Mac's
  // delete key) removes the selected ones; not while typing in a field.
  useWindowEvent("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const key = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (key === "z" || key === "y")) {
      e.preventDefault();
      if (key === "y" || e.shiftKey) redo();
      else undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "a") {
      e.preventDefault();
      setSelected(new Set(actions.keys()));
    } else if (e.key === "Escape") {
      // Cancels placing points first.
      if (placing) cancelPlacing();
      else {
        setSelected(new Set());
        setBox(null);
      }
    } else if (e.key === "s" && !e.ctrlKey && !e.metaKey) {
      toggleBoxMode();
    } else if (e.key === "m" && !e.ctrlKey && !e.metaKey) {
      toggleMove();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
      e.preventDefault();
      removeSelected();
    }
  });

  /** The selected points as funscript JSON, timed from the first. */
  /** Also adds them to the clipboard history. */
  const selectionJson = () => {
    const picked = [...selected].sort((a, b) => a - b).map((i) => actions[i]);
    const copied = picked.map((a) => ({ at: a.at - picked[0].at, pos: a.pos }));
    return remember(copied);
  };

  /** Put `copied` on top of the clipboard history, without a duplicate; returns its JSON. */
  const remember = (copied: Action[]) => {
    const json = JSON.stringify({ actions: copied });
    setHistory((h) => [copied, ...h.filter((c) => JSON.stringify({ actions: c }) !== json)].slice(0, HISTORY_SIZE));
    return json;
  };

  /** Paste a history entry and make it the clipboard again, on top of the history. */
  const pasteFromHistory = (copied: Action[]) => {
    const json = remember(copied);
    pasteJson(json);
    navigator.clipboard.writeText(json).catch((e: Error) => setError(`Copying failed: ${e.message}`));
  };

  /** Stop placing points; moved ones go back where they were, still selected. */
  const cancelPlacing = () => {
    if (lifted) setSelected(lifted);
    setPlacing(null);
    setLifted(null);
  };

  /**
   * Move mode: place the selected points again, as if cut and pasted; they
   * start where they are. Leaves selection mode; again, puts them back.
   */
  const toggleMove = () => {
    if (lifted) return cancelPlacing();
    if (!selected.size) return;
    const picked = [...selected].sort((a, b) => a - b).map((i) => actions[i]);
    setPlacing(picked.map((a) => ({ at: a.at - picked[0].at, pos: a.pos })));
    setPlaceAt(picked[0]);
    setLifted(selected);
    setSelected(new Set());
    setBoxMode(false);
    setBox(null);
  };

  /**
   * Switch selection mode; leaves move mode, putting the points back. Entered
   * with points selected, the box fits around them, selecting the points in it.
   */
  const toggleBoxMode = () => {
    const sel = lifted ?? selected;
    if (lifted) cancelPlacing();
    setBoxMode(!boxMode);
    if (!boxMode && sel.size) {
      const picked = [...sel].map((i) => actions[i]);
      selectIn(boxed(picked.reduce(extended, spanned(picked[0], picked[0]))));
    } else setBox(null);
  };

  /**
   * Start placing the points in funscript JSON: they follow the pointer until
   * a click places them. False when it holds no points.
   */
  const pasteJson = (text: string) => {
    let parsed: unknown;
    try {
      parsed = (JSON.parse(text) as { actions?: unknown } | null)?.actions;
    } catch {
      return false;
    }
    if (!Array.isArray(parsed)) return false;
    // From the clipboard, so anything could be in it.
    const valid = (parsed as Partial<Action>[])
      .filter((a): a is Action => Number.isFinite(a?.at) && Number.isFinite(a?.pos))
      .sort((a, b) => a.at - b.at);
    if (!valid.length) return false;
    cancelPlacing();
    setPlacing(valid
      .map((a) => ({ at: Math.round(a.at - valid[0].at), pos: clamp(a.pos, 0, 100) }))
      .filter((a, i, all) => i === 0 || a.at !== all[i - 1].at));
    return true;
  };

  /** The points being placed with the first at `at`, `pos`; they keep their shape and stay within 0–100. */
  const positioned = (at: number, pos: number, keepDepth: boolean) => {
    const shape = placing!;
    const lowest = Math.min(...shape.map((a) => a.pos));
    const highest = Math.max(...shape.map((a) => a.pos));
    const dp = keepDepth ? 0 : clamp(pos - shape[0].pos, -lowest, 100 - highest);
    return shape.map((a) => ({ at: Math.max(at, 0) + a.at, pos: a.pos + dp }));
  };

  /**
   * The existing points before and after `pasted` once placed. Inserting moves
   * the points from the first pasted one on right by the pasted length, so the
   * gap that followed stays, and at least 1 ms past the last pasted point.
   * Replacing drops the points in the time `pasted` covers.
   */
  const around = (pasted: Action[], insert: boolean) => {
    const [start, end] = [pasted[0].at, pasted[pasted.length - 1].at];
    const before = kept.filter((a) => a.at < start);
    if (!insert) return { before, after: kept.filter((a) => a.at > end) };
    const later = kept.slice(before.length);
    const shift = later.length ? Math.max(end - start, end + 1 - later[0].at) : 0;
    return { before, after: later.map((a) => ({ at: a.at + shift, pos: a.pos })) };
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

  /** Place the points at the pointer, inserting or replacing, and select them. */
  const place = (e: PointerEvent<SVGRectElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const point = pointerAt(e);
    const pasted = positioned(point.at, point.pos, e.ctrlKey || e.metaKey);
    const insert = insertMode !== e.shiftKey;
    const { before, after } = around(pasted, insert);
    editLabel.current = `${lifted ? "Move" : insert ? "Insert" : "Paste"} ${points(pasted.length)}`;
    setScript({ ...script, actions: [...before, ...pasted, ...after] });
    setSelected(new Set(pasted.map((_, i) => before.length + i)));
    setPlacing(null);
    setLifted(null);
  };

  /** The toolbox buttons go through the Clipboard API, which may ask for permission to paste. */
  const copyButton = async (cut: boolean) => {
    try {
      await navigator.clipboard.writeText(selectionJson());
      if (cut) removeSelected("Cut");
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
    if (e.target instanceof HTMLInputElement || !selected.size) return;
    e.preventDefault();
    e.clipboardData!.setData("text/plain", selectionJson());
    if (e.type === "cut") removeSelected("Cut");
  };
  useWindowEvent("copy", copy);
  useWindowEvent("cut", copy);
  useWindowEvent("paste", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    if (pasteJson(e.clipboardData!.getData("text/plain"))) e.preventDefault();
  });

  const open = async (file: File) => {
    try {
      const parsed = await readFunscript(file);
      setLifted(null);
      setSelected(new Set());
      editLabel.current = `Open ${file.name}`;
      const opened = Array.from(parsed.at, (at, i) => ({ at, pos: parsed.pos[i] }));
      setSaved(opened);
      setScript({ name: file.name.replace(/\.funscript$/, ""), actions: opened });
      setView((v) => ({ ...v, from: 0 }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = () => {
    const json = JSON.stringify({ version: "1.0", inverted: false, range: 100, actions });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([json], { type: "application/json" })),
      download: `${script.name || "untitled"}.funscript`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
    setSaved(actions);
  };

  /** The points being placed where they would go. */
  const ghost = placing && placeAt ? positioned(placeAt.at, placeAt.pos, held.ctrl) : null;
  /** Whether a point at `at` would be replaced by them. */
  const replaced = (at: number) => !!ghost && !inserting && at >= ghost[0].at && at <= ghost[ghost.length - 1].at;
  /** The points as drawn: while inserting, the later ones where they would move. Same order and indices as `kept`. */
  const moved = ghost && inserting ? around(ghost, true) : null;
  const shown = moved ? [...moved.before, ...moved.after] : kept;
  /** The points being placed joined to the existing points they would sit between. */
  const neighbours = ghost && (moved ?? around(ghost, false));
  const ghostLine = ghost && [neighbours!.before[neighbours!.before.length - 1], ...ghost, neighbours!.after[0]].filter((a) => a !== undefined);

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
      if (replaced(visible[j].at) || Math.hypot(x(visible[j].at) - px, y(visible[j].pos) - py) > (selected.has(i) ? 8 : 5)) continue;
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
    Object.assign(ctx, { lineWidth: 2, lineJoin: "round", strokeStyle: LINE_COLOR, fillStyle: LINE_COLOR });
    for (const segment of segments) {
      ctx.beginPath();
      for (const a of segment) ctx.lineTo(x(a.at), y(a.pos));
      ctx.stroke();
    }
    // The line through selected points is drawn over; a short run of them in view also shows rings, so zoomed in, a long run's part in view does too.
    const long = new Array<boolean>(visible.length).fill(false);
    for (let j = 0; j < visible.length; ) {
      let end = j;
      while (end < visible.length && selected.has(first + end)) end++;
      if (end - j > RING_LIMIT) long.fill(true, j, end);
      j = Math.max(end, j + 1);
    }
    const line = new Path2D();
    for (let j = 1; j < visible.length; j++) {
      const [a, b] = [visible[j - 1], visible[j]];
      if (!selected.has(first + j - 1) || !selected.has(first + j) || replaced(a.at) || replaced(b.at)) continue;
      line.moveTo(x(a.at), y(a.pos));
      line.lineTo(x(b.at), y(b.pos));
    }
    ctx.strokeStyle = css.getPropertyValue("--gray-12");
    ctx.stroke(line);
    // Packed this close, the points would only blur the line.
    const showDots = visible.length * DOT_SPACING < width;
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
      const ring = selected.has(first + j) && !long[j];
      if (!ring && !showDots) return;
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
  });
  /** The selection box's sides, in px. */
  const edges = box && { from: x(box.from), to: x(box.to), low: y(box.low), high: y(box.high) };

  const sidebar = (
    <Flex direction="column" gap="3" p="3">
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
      <Flex gap="2">
        <Button
          variant="soft"
          style={{ flex: 1 }}
          onClick={() => {
            if (actions.length && !confirm("Discard the current script?")) return;
            setLifted(null);
            setSelected(new Set());
            editLabel.current = "New script";
            setSaved(EMPTY.actions);
            setScript(EMPTY);
            setView((v) => ({ ...v, from: 0 }));
          }}
        >
          <FileIcon /> New
        </Button>
        <Button variant="soft" style={{ flex: 1 }} onClick={() => input.current?.click()}>
          <UploadIcon /> Open
        </Button>
      </Flex>
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
          }
          e.target.value = "";
        }}
      />
      <Flex gap="2">
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
      </Flex>
      <Box>
        <Text as="label" size="2" weight="medium" mb="1" style={{ display: "block" }} htmlFor="editor-name">Name</Text>
        <TextField.Root id="editor-name" value={script.name} onChange={(e) => setScript({ ...script, name: e.target.value })} />
      </Box>
      <Button disabled={actions.length < 2} onClick={save}>
        <DownloadIcon /> Save
      </Button>
      {error && (
        <Callout.Root color="red" size="1">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      <Text size="2" color="gray">
        {actions.length} points{selected.size > 1 && ` · ${selected.size} selected`} · {formatScriptTime(end / 1000)}
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

  /** The selected point when there is just one, labelled with its time and position. */
  const only = selected.size === 1 ? [...selected][0] : null;

  const content = (
    <Flex direction="column" gap="3" p="3" height="100%">
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
                        {k > 0 && <DiffPreview before={timeline.states[k - 1].actions} after={state.actions} />}
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
        <IconButton variant="soft" color="gray" disabled={!selected.size} aria-label="Copy" title="Copy (Ctrl+C)" onClick={() => void copyButton(false)}>
          <CopyIcon />
        </IconButton>
        <IconButton variant="soft" color="gray" disabled={!selected.size} aria-label="Cut" title="Cut (Ctrl+X)" onClick={() => void copyButton(true)}>
          <ScissorsIcon />
        </IconButton>
        {/* With a history, its button docks to the paste button. */}
        <Flex>
          <IconButton
            variant="soft"
            color="gray"
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
                          {points(copied.length)} · {formatScriptTime(copied[copied.length - 1].at / 1000)}
                        </Button>
                      </Popover.Close>
                    </HoverCard.Trigger>
                    <HoverCard.Content side="right" size="1">
                      <PreviewGraph lines={[{ actions: copied, color: LINE_COLOR }]} from={0} to={copied[copied.length - 1].at} />
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
          disabled={!lifted && !selected.size}
          title="Move the selected points (M)"
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
      </Flex>
      <Box ref={boxRef} position="relative" flexGrow="1" minHeight="120px" style={{ borderRadius: 6, background: "var(--gray-a2)", overflow: "hidden" }}>
        <svg
          width={width}
          height={height}
          onPointerDown={add}
          onPointerMove={(e) => {
            // Points are drawn on the canvas, so the cursor shows when one can be grabbed.
            e.currentTarget.style.cursor = pointUnder(e) === null ? "crosshair" : "grab";
            if (!placing) return;
            setPlaceAt(pointerAt(e));
            setHeld({ shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
          }}
          onPointerLeave={() => setPlaceAt(null)}
          style={{ display: "block", cursor: "crosshair", touchAction: "none", userSelect: "none" }}
        >
          {[0, 50, 100].map((pos) => (
            <line key={pos} x1={0} x2={width} y1={y(pos)} y2={y(pos)} style={{ stroke: "var(--gray-a5)" }} />
          ))}
          {timeTicks(view.from / 1000, (view.from + view.span) / 1000).map((t) => (
            <g key={t}>
              <line x1={x(t * 1000)} x2={x(t * 1000)} y1={0} y2={plotHeight} style={{ stroke: "var(--gray-a4)" }} />
              <text x={x(t * 1000)} y={height - 6} textAnchor="middle" fontSize={11} style={{ fill: "var(--gray-11)" }}>
                {formatTimeTick(t)}
              </text>
            </g>
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
          {ghost && (
            <rect
              x={x(ghost[0].at)}
              width={Math.max(x(ghost[ghost.length - 1].at) - x(ghost[0].at), 1)}
              y={0}
              height={plotHeight}
              style={{ fill: inserting ? "var(--green-a3)" : "var(--red-a3)", pointerEvents: "none" }}
            />
          )}
          {/* Kept in the SVG, so the line and points stay between what is drawn under and over them. */}
          <foreignObject width={width} height={height} style={{ pointerEvents: "none" }}>
            <canvas ref={canvasRef} style={{ display: "block", width, height }} />
          </foreignObject>
          {/* The copied points' original lowest and highest depth, what Ctrl keeps them at. */}
          {ghost && placing && [Math.min(...placing.map((a) => a.pos)), Math.max(...placing.map((a) => a.pos))].map((pos, i) => (
            <line key={i} x1={0} x2={width} y1={y(pos)} y2={y(pos)} strokeDasharray="6 4" style={{ stroke: LINE_COLOR, opacity: 0.6, pointerEvents: "none" }} />
          ))}
          {ghost && (
            <g opacity={0.6} style={{ pointerEvents: "none" }}>
              <polyline
                points={ghostLine!.map((a) => `${x(a.at)},${y(a.pos)}`).join(" ")}
                fill="none"
                stroke={LINE_COLOR}
                strokeWidth={2}
                strokeDasharray="4 3"
              />
              {ghost.map((a, i) => <circle key={i} cx={x(a.at)} cy={y(a.pos)} r={5} fill={LINE_COLOR} />)}
            </g>
          )}
          {/* While placing, a click anywhere places, over points and the playhead alike. */}
          {edges && (
            <g>
              <rect
                x={edges.from}
                y={edges.high}
                width={edges.to - edges.from}
                height={edges.low - edges.high}
                strokeDasharray="4 2"
                style={{ fill: "var(--accent-a3)", stroke: "var(--accent-9)", cursor: "move", pointerEvents: boxMode ? undefined : "none" }}
                onPointerDown={(e) => editBox(e, ["from", "to", "low", "high"])}
              />
              {/* Selecting by time, only the edges in time can be dragged. */}
              {boxMode && GRIPS.filter(([, v]) => !selectByTime || !v).map(([h, v]) => (
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
          {placing && (
            // No menu for Ctrl+click, which is a right-click on a Mac.
            <rect width={width} height={height} fill="transparent" style={{ cursor: "copy" }} onPointerDown={place} onContextMenu={(e) => e.preventDefault()} />
          )}
          {only !== null && shown[only] && (
            <text
              x={x(shown[only].at)}
              y={y(shown[only].pos) + (shown[only].pos > 80 ? 22 : -12)}
              textAnchor="middle"
              fontSize={12}
              style={{ fill: "var(--gray-12)" }}
            >
              {formatScriptTime(shown[only].at / 1000, 2)} · {Math.round(shown[only].pos)}
            </text>
          )}
        </svg>
        {placing && (
          <Text size="1" style={{ position: "absolute", top: 4, left: 8, padding: "2px 6px", borderRadius: 4, background: "var(--color-panel-solid)", pointerEvents: "none" }}>
            Click to {inserting ? "insert" : "place"} {points(placing.length)} · Shift to {inserting ? "replace" : "insert"} · Ctrl keeps depths · Esc cancels
          </Text>
        )}
        {/* As in the player: 100 (top) is the shallow end, out towards home. */}
        <Text size="1" color="gray" style={{ position: "absolute", top: 4, right: 8, pointerEvents: "none" }}>Out</Text>
        <Text size="1" color="gray" style={{ position: "absolute", bottom: AXIS + 4, right: 8, pointerEvents: "none" }}>In</Text>
      </Box>
      {minimap ? (
        <svg
          width={width}
          height={MINIMAP_HEIGHT}
          aria-label="Minimap"
          onPointerDown={dragMinimap}
          style={{ display: "block", flexShrink: 0, borderRadius: 6, background: "var(--gray-a2)", touchAction: "none", userSelect: "none" }}
        >
          {/* ponytail: the whole script as one polyline; fine for thousands of points, thin it out if a long script lags. */}
          <polyline
            points={actions.map((a) => `${minimapX(a.at)},${2 + (1 - a.pos / 100) * (MINIMAP_HEIGHT - 4)}`).join(" ")}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={1}
          />
          {/* The selected runs over it, a lone selected point as a dot. */}
          <path
            d={kept.map((a, i) => selected.has(i) ? `${selected.has(i - 1) ? "L" : "M"}${minimapX(a.at)},${2 + (1 - a.pos / 100) * (MINIMAP_HEIGHT - 4)}${selected.has(i - 1) ? "" : "l0,0"}` : "").join("")}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ stroke: "var(--gray-12)", pointerEvents: "none" }}
          />
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

  return <GraphLayout sidebar={sidebar} content={content} />;
}

/** Height of a small graph's time axis, in px. */
const PREVIEW_AXIS = 12;

/** Size and scales of a small graph over `from`–`to` ms, its time axis below. */
function previewScale(from: number, to: number) {
  const [width, plotHeight, pad] = [200, 60, 4];
  const span = to - from || 1;
  return {
    from,
    to,
    width,
    plotHeight,
    height: plotHeight + PREVIEW_AXIS,
    x: (at: number) => pad + ((at - from) / span) * (width - 2 * pad),
    y: (pos: number) => pad + (1 - pos / 100) * (plotHeight - 2 * pad),
  };
}

/** The 0, 50 and 100 lines of a small graph, and its time ticks with labels. */
function PreviewAxes({ from, to, width, plotHeight, height, x, y }: ReturnType<typeof previewScale>) {
  const ticks = timeTicks(from / 1000, to / 1000, 3);
  // Enough decimals to tell the ticks apart: their steps are 1, 2 or 5 times a power of ten below a second.
  const decimals = ticks.length > 1 ? Math.max(0, -Math.floor(Math.log10(ticks[1] - ticks[0]) + 1e-9)) : 1;
  return (
    <>
      {[0, 50, 100].map((pos) => (
        <line key={pos} x1={0} x2={width} y1={y(pos)} y2={y(pos)} style={{ stroke: "var(--gray-a5)" }} />
      ))}
      {ticks.map((t) => {
        const tx = x(t * 1000);
        // Kept inside the graph at its edges.
        const anchor = tx < 20 ? "start" : tx > width - 20 ? "end" : "middle";
        return (
          <g key={t}>
            <line x1={tx} x2={tx} y1={0} y2={plotHeight} style={{ stroke: "var(--gray-a4)" }} />
            <text x={tx} y={height - 2} textAnchor={anchor} fontSize={9} style={{ fill: "var(--gray-11)" }}>
              {formatScriptTime(t, decimals)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** A small graph of point lines over `from`–`to` ms; dots only while there are few. */
function PreviewGraph({ lines, from, to }: {
  lines: { actions: Action[]; color: string; dashed?: boolean }[];
  from: number;
  to: number;
}) {
  const scale = previewScale(from, to);
  const { width, height, x, y } = scale;
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <PreviewAxes {...scale} />
      {lines.map(({ actions, color, dashed }, l) => (
        <g key={l} style={{ stroke: color, fill: color }}>
          <polyline points={actions.map((a) => `${x(a.at)},${y(a.pos)}`).join(" ")} fill="none" strokeWidth={1.5} strokeDasharray={dashed ? "3 2" : undefined} />
          {actions.length <= 200 && actions.map((a, i) => <circle key={i} cx={x(a.at)} cy={y(a.pos)} r={2} stroke="none" />)}
        </g>
      ))}
    </svg>
  );
}

/**
 * What an edit changed, as a diff like placing shows it: the time removed points
 * covered in red, their old line dashed and the points crossed out; the time added
 * points cover in green, with their line. One unchanged point on each side joins
 * both. Unchanged points are the same objects in both.
 */
function DiffPreview({ before, after }: { before: Action[]; after: Action[] }) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  const context = [before[start - 1], before[before.length - end]].filter((a) => a !== undefined);
  const all = [...context, ...removed, ...added];
  if (!all.length) return <Text size="1" color="gray">No points</Text>;
  const scale = previewScale(Math.min(...all.map((a) => a.at)), Math.max(...all.map((a) => a.at)));
  const { width, plotHeight, height, x, y } = scale;
  const line = (changed: Action[]) => [before[start - 1], ...changed, before[before.length - end]].filter((a) => a !== undefined).map((a) => `${x(a.at)},${y(a.pos)}`).join(" ");
  const band = (changed: Action[], color: string) => changed.length > 0 && (
    <rect x={x(changed[0].at)} width={Math.max(x(changed[changed.length - 1].at) - x(changed[0].at), 1)} y={0} height={plotHeight} style={{ fill: color }} />
  );
  const dots = all.length <= 200;
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {band(removed, "var(--red-a3)")}
      {band(added, "var(--green-a3)")}
      <PreviewAxes {...scale} />
      {/* As many points before as after: each moved, so join it to where it went. */}
      {/* ponytail: pairs by order, so an edit that both moves and adds points shows no moves; match by nearest time if that misleads. */}
      {dots && removed.length === added.length && removed.map((a, i) => (
        <line key={i} x1={x(a.at)} y1={y(a.pos)} x2={x(added[i].at)} y2={y(added[i].pos)} strokeWidth={1} style={{ stroke: "var(--gray-8)" }} />
      ))}
      <polyline points={line(removed)} fill="none" strokeWidth={1.5} strokeDasharray="3 2" style={{ stroke: "var(--red-9)" }} />
      <polyline points={line(added)} fill="none" strokeWidth={1.5} style={{ stroke: "var(--green-9)" }} />
      {dots && removed.map((a, i) => (
        <path key={i} d={`M${x(a.at) - 2.5},${y(a.pos) - 2.5} l5,5 m0,-5 l-5,5`} strokeWidth={1.5} style={{ stroke: "var(--red-9)" }} />
      ))}
      {dots && added.map((a, i) => <circle key={i} cx={x(a.at)} cy={y(a.pos)} r={2.5} style={{ fill: "var(--green-9)" }} />)}
      {context.map((a, i) => <circle key={i} cx={x(a.at)} cy={y(a.pos)} r={2} style={{ fill: "var(--gray-9)" }} />)}
    </svg>
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
