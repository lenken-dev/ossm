import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Box, Button, Callout, Flex, HoverCard, IconButton, Popover, Slider, Switch, Text, TextField } from "@radix-ui/themes";
import { ClipboardIcon, CopyIcon, CounterClockwiseClockIcon, Cross2Icon, DownloadIcon, ExclamationTriangleIcon, FileIcon, GearIcon, PauseIcon, PlayIcon, ScissorsIcon, TrackNextIcon, TrackPreviousIcon, UploadIcon, VideoIcon } from "@radix-ui/react-icons";
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
  /** The latest copies, newest first; for this visit to the page. */
  const [history, setHistory] = useState<Action[][]>([]);
  /** Script time under the pointer while it is over the graph, in ms; where paste goes without media. */
  const pointerTime = useRef<number | null>(null);
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

  const removeSelected = () => {
    setScript((s) => ({ ...s, actions: s.actions.filter((_, j) => !selected.has(j)) }));
    setSelected(new Set());
  };

  // Ctrl/Cmd+A selects all points, Escape none, Delete (or Backspace, the Mac's
  // delete key) removes the selected ones; not while typing in a field.
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        setSelected(new Set(actions.keys()));
      } else if (e.key === "Escape") {
        setSelected(new Set());
      } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size) {
        e.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
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
   * Paste funscript JSON at the playhead, or without media at the pointer,
   * replacing the points in the time it covers. False when it holds no points.
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
    const start = Math.max(Math.round(videoUrl ? time : pointerTime.current ?? view.from + view.span / 2), 0);
    const pasted = valid
      .map((a) => ({ at: start + Math.round(a.at - valid[0].at), pos: clamp(a.pos, 0, 100) }))
      .filter((a, i, all) => i === 0 || a.at !== all[i - 1].at);
    const end = pasted[pasted.length - 1].at;
    const before = actions.filter((a) => a.at < start);
    const after = actions.filter((a) => a.at > end);
    setScript({ ...script, actions: [...before, ...pasted, ...after] });
    setSelected(new Set(pasted.map((_, i) => before.length + i)));
    return true;
  };

  /** The toolbox buttons go through the Clipboard API, which may ask for permission to paste. */
  const copyButton = async (cut: boolean) => {
    try {
      await navigator.clipboard.writeText(selectionJson());
      if (cut) removeSelected();
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
  useEffect(() => {
    const copy = (e: ClipboardEvent) => {
      if (e.target instanceof HTMLInputElement || !selected.size) return;
      e.preventDefault();
      e.clipboardData!.setData("text/plain", selectionJson());
      if (e.type === "cut") removeSelected();
    };
    const paste = (e: ClipboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (pasteJson(e.clipboardData!.getData("text/plain"))) e.preventDefault();
    };
    window.addEventListener("copy", copy);
    window.addEventListener("cut", copy);
    window.addEventListener("paste", paste);
    return () => {
      window.removeEventListener("copy", copy);
      window.removeEventListener("cut", copy);
      window.removeEventListener("paste", paste);
    };
  });

  const open = async (file: File) => {
    try {
      const parsed = await readFunscript(file);
      setSelected(new Set());
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

  // The points in view and one beyond each edge, so the line reaches the edges.
  // ponytail: all points in view are drawn as SVG; zoomed out on a dense script that is thousands of nodes, switch to canvas if it lags.
  const first = Math.max(byTime(actions, view.from) - 1, 0);
  const last = Math.min(byTime(actions, view.from + view.span) + 1, actions.length);
  const visible = actions.slice(first, last);
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
      <Text as="label" size="2" weight="medium">
        <Flex align="center" justify="between" gap="2">
          Box select
          <Switch checked={boxMode} onCheckedChange={setBoxMode} />
        </Flex>
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
      <Text size="1" color="gray">
        Click to add a point, click a point to select it, drag it to move it. Ctrl+click adds to the selection,
        Shift+click selects a range, Ctrl+A selects all, Escape none. Shift+drag (or drag with Box select on) selects the points in a box. Delete removes the selected points; Ctrl+C, Ctrl+X and Ctrl+V copy, cut and paste them, pasting at the playhead (without media, at the pointer). Scroll to
        move through time, Ctrl+scroll to zoom.{videoUrl && !isAudio && " Drag the bottom edge of the video to change its height."}
      </Text>
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
                          {copied.length} {copied.length === 1 ? "point" : "points"} · {formatScriptTime(copied[copied.length - 1].at / 1000)}
                        </Button>
                      </Popover.Close>
                    </HoverCard.Trigger>
                    <HoverCard.Content side="right" size="1">
                      <PointsPreview actions={copied} />
                    </HoverCard.Content>
                  </HoverCard.Root>
                ))}
                <Text size="1" color="gray" mt="1">Click an entry to paste it and make it the clipboard again.</Text>
              </Flex>
            </Popover.Content>
          </Popover.Root>}
        </Flex>
      </Flex>
      <Box ref={boxRef} position="relative" flexGrow="1" minHeight="120px" style={{ borderRadius: 6, background: "var(--gray-a2)", overflow: "hidden" }}>
        <svg
          width={width}
          height={height}
          onPointerDown={add}
          onPointerMove={(e) => void (pointerTime.current = pointerAt(e).at)}
          onPointerLeave={() => void (pointerTime.current = null)}
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
              fill={LINE_COLOR}
              strokeWidth={2}
              style={{ cursor: "grab", stroke: selected.has(first + j) ? "var(--gray-12)" : "none" }}
              onPointerDown={(e) => pointDown(e, first + j)}
            />
          ))}
          {box && <rect {...box} strokeDasharray="4 2" style={{ fill: "var(--accent-a3)", stroke: "var(--accent-9)", pointerEvents: "none" }} />}
          {only !== null && actions[only] && (
            <text
              x={x(actions[only].at)}
              y={y(actions[only].pos) + (actions[only].pos > 80 ? 22 : -12)}
              textAnchor="middle"
              fontSize={12}
              style={{ fill: "var(--gray-12)" }}
            >
              {formatScriptTime(actions[only].at / 1000, 2)} · {Math.round(actions[only].pos)}
            </text>
          )}
        </svg>
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

/** A small graph of copied points, scaled to fit. */
function PointsPreview({ actions }: { actions: Action[] }) {
  const [width, height, pad] = [200, 60, 4];
  const duration = actions[actions.length - 1].at || 1;
  const x = (at: number) => pad + (at / duration) * (width - 2 * pad);
  const y = (pos: number) => pad + (1 - pos / 100) * (height - 2 * pad);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={actions.map((a) => `${x(a.at)},${y(a.pos)}`).join(" ")} fill="none" stroke={LINE_COLOR} strokeWidth={1.5} />
      {actions.map((a, i) => <circle key={i} cx={x(a.at)} cy={y(a.pos)} r={2} fill={LINE_COLOR} />)}
    </svg>
  );
}
