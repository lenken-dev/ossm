import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Box, Button, Callout, Flex, HoverCard, IconButton, Popover, Slider, Text, TextField } from "@radix-ui/themes";
import { ClipboardIcon, ColumnSpacingIcon, CopyIcon, ResetIcon, CounterClockwiseClockIcon, Cross2Icon, DownloadIcon, ExclamationTriangleIcon, FileIcon, GearIcon, PauseIcon, PlayIcon, ScissorsIcon, TrackNextIcon, TrackPreviousIcon, UploadIcon, VideoIcon } from "@radix-ui/react-icons";
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

const EMPTY: Script = { name: "untitled", actions: [] };

/** Copies kept in the clipboard history. */
const HISTORY_SIZE = 10;
/** Edits kept for undo. */
const UNDO_SIZE = 100;

/** Visible time range, in ms. */
const MIN_SPAN = 500;
const MAX_SPAN = 120_000;

/** Height of the time axis below the graph and space above and below the points, in px. */
const AXIS = 20;
const PAD = 10;

const LINE_COLOR = "#ec4899";

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
  /** Dragging on empty space draws a box that selects points instead of adding one; Shift does the same once. */
  const [boxMode, setBoxMode] = useState(false);
  /** The selection box being drawn, in px. */
  /** Pasted points, timed from the first, that follow the pointer until a click places them. */
  const [placing, setPlacing] = useState<Action[] | null>(null);
  /** Where the first point being placed is, under the pointer. */
  const [placeAt, setPlaceAt] = useState<Action | null>(null);
  /** Placing inserts, moving later points right, instead of replacing the points the pasted ones cover. */
  const [insertMode, setInsertMode] = usePersistedState("ossm:editorInsert", false, localStorage);
  /**
   * Modifiers held while placing: Shift switches to the other mode, Ctrl (or
   * Cmd) keeps the copied depths instead of following the pointer's.
   */
  const [held, setHeld] = useState({ shift: false, ctrl: false });
  const inserting = insertMode !== held.shift;
  /** The latest copies, newest first; for this visit to the page. */
  const [history, setHistory] = useState<Action[][]>([]);
  const [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  /** The point last clicked without Shift, where a Shift+click range starts. */
  const anchor = useRef<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const videoInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLMediaElement>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  /** An audio file plays in a bar instead of the video area. */
  const isAudio = !!videoFile?.type.startsWith("audio/");
  /** Separate from the player's sizes. */
  const [videoHeight, setVideoHeight] = usePersistedState("ossm:editorVideoHeight", VIDEO_HEIGHT, localStorage);
  const [paused, setPaused] = useState(true);
  const [steps, setSteps] = usePersistedState("ossm:editorSteps", DEFAULT_STEPS, localStorage);
  /** The steps in use; a first step that is not a positive number falls back to the default. */
  const shownSteps = steps.map(Number).map((v, i) => (v > 0 ? v : i === 0 ? Number(DEFAULT_STEPS[0]) : null)).filter((v) => v !== null);
  /** Video time, in ms. */
  const [time, setTime] = useState(0);

  useEffect(() => {
    setVideoUrl(null);
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

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
        const span = clamp(v.span * Math.exp(e.deltaY * 0.002), MIN_SPAN, MAX_SPAN);
        return { from: Math.max(v.from + fraction * (v.span - span), 0), span };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [setView]);

  const { actions } = script;

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
  };
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

  /**
   * Draw a box from the pointer and add the points in it to the selection; a
   * click without dragging clears the selection.
   */
  const boxSelect = (e: PointerEvent<SVGSVGElement>) => {
    e.preventDefault();
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const base = selected;
    const [x0, y0] = [e.clientX - rect.left, e.clientY - rect.top];
    let moved = false;
    const move = (m: globalThis.PointerEvent) => {
      const [x1, y1] = [m.clientX - rect.left, m.clientY - rect.top];
      moved ||= Math.hypot(x1 - x0, y1 - y0) > 3;
      if (!moved) return;
      const [left, right, top, bottom] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
      setBox({ x: left, y: top, width: right - left, height: bottom - top });
      const next = new Set(base);
      // Only points in view can be in the box.
      for (let i = first; i < last; i++) {
        const [px, py] = [x(actions[i].at), y(actions[i].pos)];
        if (px >= left && px <= right && py >= top && py <= bottom) next.add(i);
      }
      setSelected(next);
    };
    svg.setPointerCapture(e.pointerId);
    svg.addEventListener("pointermove", move);
    svg.addEventListener("lostpointercapture", () => {
      svg.removeEventListener("pointermove", move);
      setBox(null);
      if (!moved) setSelected(new Set());
    }, { once: true });
  };

  /** Add a point under the pointer and keep dragging it; with several points selected, only clear the selection. */
  const add = (e: PointerEvent<SVGSVGElement>) => {
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
   * keeps the selection it is in, and drags.
   */
  const pointDown = (e: PointerEvent<SVGCircleElement>, i: number) => {
    if (e.button !== 0) return;
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
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
      // Cancels placing pasted points first.
      if (placing) setPlacing(null);
      else setSelected(new Set());
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
    const before = actions.filter((a) => a.at < start);
    if (!insert) return { before, after: actions.filter((a) => a.at > end) };
    const later = actions.slice(before.length);
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
    editLabel.current = `${insert ? "Insert" : "Paste"} ${points(pasted.length)}`;
    setScript({ ...script, actions: [...before, ...pasted, ...after] });
    setSelected(new Set(pasted.map((_, i) => before.length + i)));
    setPlacing(null);
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
      setSelected(new Set());
      editLabel.current = `Open ${file.name}`;
      setScript({ name: file.name.replace(/\.funscript$/, ""), actions: Array.from(parsed.at, (at, i) => ({ at, pos: parsed.pos[i] })) });
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
  };

  /** The points being placed where they would go. */
  const ghost = placing && placeAt ? positioned(placeAt.at, placeAt.pos, held.ctrl) : null;
  /** Whether a point at `at` would be replaced by them. */
  const replaced = (at: number) => !!ghost && !inserting && at >= ghost[0].at && at <= ghost[ghost.length - 1].at;
  /** The points as drawn: while inserting, the later ones where they would move. Same order and indices as `actions`. */
  const moved = ghost && inserting ? around(ghost, true) : null;
  const shown = moved ? [...moved.before, ...moved.after] : actions;

  // The points in view and one beyond each edge, so the line reaches the edges.
  // ponytail: all points in view are drawn as SVG; zoomed out on a dense script that is thousands of nodes, switch to canvas if it lags.
  const first = Math.max(byTime(shown, view.from) - 1, 0);
  const last = Math.min(byTime(shown, view.from + view.span) + 1, shown.length);
  const visible = shown.slice(first, last);
  const end = actions.length ? actions[actions.length - 1].at : 0;

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
            setSelected(new Set());
            editLabel.current = "New script";
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
        display={`${(view.span / 1000).toFixed(1)} s`}
        min={MIN_SPAN / 1000}
        max={MAX_SPAN / 1000}
        step={0.5}
        onChange={(s) => setView({ ...view, span: s * 1000 })}
      />
    </Flex>
  );

  const mediaProps = {
    ref: (el: HTMLMediaElement | null) => void (videoRef.current = el),
    src: videoUrl ?? undefined,
    controls: true,
    onPlay: () => setPaused(false),
    onPause: () => setPaused(true),
    onEmptied: () => setPaused(true),
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
      <Flex gap="2" flexShrink="0">
        {/* Undo with its history docked, as paste with the clipboard history. */}
        <Flex>
          <Button
            variant="soft"
            color="gray"
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            onClick={undo}
            style={{ borderTopRightRadius: 0, borderBottomRightRadius: 0 }}
          >
            <ResetIcon /> Undo
          </Button>
          <Popover.Root>
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
                          {state.label}
                        </Button>
                      </Popover.Close>
                    </HoverCard.Trigger>
                    {k > 0 && (
                      <HoverCard.Content side="right" size="1">
                        <DiffPreview before={timeline.states[k - 1].actions} after={state.actions} />
                      </HoverCard.Content>
                    )}
                  </HoverCard.Root>
                )).reverse()}
                <Text size="1" color="gray" mt="1">Click an entry to go back or forward to it.</Text>
              </Flex>
            </Popover.Content>
          </Popover.Root>
        </Flex>
        <Button variant="soft" color="gray" disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" onClick={redo}>
          <ResetIcon style={{ transform: "scaleX(-1)" }} /> Redo
        </Button>
        <Button
          variant={boxMode ? "solid" : "soft"}
          color={boxMode ? undefined : "gray"}
          aria-pressed={boxMode}
          title="Selection mode: drag to select points (or Shift+drag)"
          onClick={() => setBoxMode(!boxMode)}
        >
          {/* A dashed selection box, sized like the icons. */}
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <rect x="2" y="2" width="11" height="11" rx="1" stroke="currentColor" strokeDasharray="2 2" />
          </svg>
          Select
        </Button>
        <Button variant="soft" color="gray" disabled={!selected.size} title="Copy (Ctrl+C)" onClick={() => void copyButton(false)}>
          <CopyIcon /> Copy
        </Button>
        <Button variant="soft" color="gray" disabled={!selected.size} title="Cut (Ctrl+X)" onClick={() => void copyButton(true)}>
          <ScissorsIcon /> Cut
        </Button>
        {/* With a history, its button docks to the paste button. */}
        <Flex>
          <Button
            variant="soft"
            color="gray"
            title="Paste (Ctrl+V)"
            onClick={() => void pasteButton()}
            style={history.length ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : undefined}
          >
            <ClipboardIcon /> Paste
          </Button>
          {history.length > 0 && <Popover.Root>
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
          <polyline
            points={visible.map((a) => `${x(a.at)},${y(a.pos)}`).join(" ")}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {visible.map((a, j) => (
            <circle
              key={first + j}
              cx={x(a.at)}
              cy={y(a.pos)}
              r={selected.has(first + j) ? 7 : 5}
              strokeWidth={2}
              opacity={replaced(a.at) ? 0.5 : 1}
              style={{
                cursor: "grab",
                fill: replaced(a.at) ? "var(--red-9)" : LINE_COLOR,
                stroke: selected.has(first + j) ? "var(--gray-12)" : "none",
              }}
              onPointerDown={(e) => pointDown(e, first + j)}
            />
          ))}
          {/* The copied points' original lowest and highest depth, what Ctrl keeps them at. */}
          {ghost && placing && [Math.min(...placing.map((a) => a.pos)), Math.max(...placing.map((a) => a.pos))].map((pos, i) => (
            <line key={i} x1={0} x2={width} y1={y(pos)} y2={y(pos)} strokeDasharray="6 4" style={{ stroke: LINE_COLOR, opacity: 0.6, pointerEvents: "none" }} />
          ))}
          {ghost && (
            <g opacity={0.6} style={{ pointerEvents: "none" }}>
              <polyline
                points={ghost.map((a) => `${x(a.at)},${y(a.pos)}`).join(" ")}
                fill="none"
                stroke={LINE_COLOR}
                strokeWidth={2}
                strokeDasharray="4 3"
              />
              {ghost.map((a, i) => <circle key={i} cx={x(a.at)} cy={y(a.pos)} r={5} fill={LINE_COLOR} />)}
            </g>
          )}
          {/* While placing, a click anywhere places, over points and the playhead alike. */}
          {placing && (
            // No menu for Ctrl+click, which is a right-click on a Mac.
            <rect width={width} height={height} fill="transparent" style={{ cursor: "copy" }} onPointerDown={place} onContextMenu={(e) => e.preventDefault()} />
          )}
          {box && <rect {...box} strokeDasharray="4 2" style={{ fill: "var(--accent-a3)", stroke: "var(--accent-9)", pointerEvents: "none" }} />}
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
      <Slider
        aria-label="Scroll through time"
        min={0}
        max={Math.max(end, view.span)}
        step={10}
        value={[view.from]}
        onValueChange={([from]) => setView({ ...view, from })}
      />
    </Flex>
  );

  return <GraphLayout sidebar={sidebar} content={content} />;
}

/** A small graph of point lines over `from`–`to` ms; dots only while there are few. */
function PreviewGraph({ lines, from, to }: {
  lines: { actions: Action[]; color: string; dashed?: boolean }[];
  from: number;
  to: number;
}) {
  const [width, height, pad] = [200, 60, 4];
  const span = to - from || 1;
  const x = (at: number) => pad + ((at - from) / span) * (width - 2 * pad);
  const y = (pos: number) => pad + (1 - pos / 100) * (height - 2 * pad);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
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
 * What an edit changed: the points before (grey, dashed) and after, with one
 * unchanged point on each side. Unchanged points are the same objects in both.
 */
function DiffPreview({ before, after }: { before: Action[]; after: Action[] }) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  const old = before.slice(Math.max(start - 1, 0), before.length - end + 1);
  const now = after.slice(Math.max(start - 1, 0), after.length - end + 1);
  const ats = [old[0], now[0], old[old.length - 1], now[now.length - 1]].filter(Boolean).map((a) => a.at);
  if (!ats.length) return <Text size="1" color="gray">No points</Text>;
  return (
    <PreviewGraph
      lines={[{ actions: old, color: "var(--gray-9)", dashed: true }, { actions: now, color: LINE_COLOR }]}
      from={Math.min(...ats)}
      to={Math.max(...ats)}
    />
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
