import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type MediaHTMLAttributes, type PointerEvent, type RefObject, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { AlertDialog, Box, Button, Callout, Dialog, Flex, Heading, IconButton, SegmentedControl, Select, Separator, Switch, Text, Theme, Tooltip } from "@radix-ui/themes";
import {
  CheckIcon,
  ChevronRightIcon,
  Cross2Icon,
  EnterFullScreenIcon,
  ExclamationTriangleIcon,
  ExitFullScreenIcon,
  GearIcon,
  HamburgerMenuIcon,
  HomeIcon,
  MoveIcon,
  OpenInNewWindowIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
  UploadIcon,
} from "@radix-ui/react-icons";
import { bisectLeft } from "d3";
import { useAppearance } from "../hooks/useAppearance";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePersistedState } from "../hooks/usePersistedState";
import { log, useOssm, type Ossm, type OssmState, type PatternInfo } from "../player/ble";
import { FunscriptStream, simplify } from "../player/stream";
import { parseFunscript, readFunscript, SENT_SCRIPT_KEY, type Funscript } from "../StreamPanel";
import { LabeledSlider } from "../TrajectoryPanel";
import { GraphLayout } from "./GraphPage";

type PlayerMode = "pattern" | "funscript";

/** Where dialogs, menus and tooltips open: the popout window's body while the controls are in it. */
const PortalContainer = createContext<HTMLElement | undefined>(undefined);

/** Size the popout window opens at, in px. */
const POPOUT_SIZE = { width: 320, height: 640 };

/** How long a slider shows the user's value before following the device again; the device reports settings at least once a second. */
const PENDING_MS = 1500;

/** Default and smallest height of the preview graph below the video, in px. */
const PREVIEW_HEIGHT = 140;
const PREVIEW_MIN_HEIGHT = 60;
/** Default time the preview graphs show before and after the video time, in ms. */
const DEFAULT_WINDOW = { before: 2000, after: 8000 };
/** Choices for the time after the video time, in s: by the second up to 30 s, then by 10 s. */
const AFTER_STOPS = [...Array.from({ length: 30 }, (_, i) => i + 1), 40, 50, 60, 70, 80, 90, 100, 110, 120];

/** Place and look of the graph over the video in theater mode. */
interface OverlayStyle {
  /** Position and size, in fractions of the video area. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Also the line width of the graph below the video. */
  lineWidth: number;
  /** Opacity of the black background, in percent. */
  background: number;
}
/** Full width, ending above Chrome's video controls in most window sizes. */
const DEFAULT_OVERLAY: OverlayStyle = { x: 0, y: 0.7, width: 1, height: 0.18, lineWidth: 2, background: 0 };

/** Smallest graph over the video while resizing, in px; room for the corner handles. */
const OVERLAY_MIN_WIDTH = 120;
const OVERLAY_MIN_HEIGHT = 60;

/** Resize handles of the graph over the video, by the corner they move. */
const RESIZE_HANDLES = ["nw", "ne", "se", "sw"];
const CORNER_HANDLE = 24;

/** Where a resize handle sits and how it looks: an L in its corner. */
function handleStyle(handle: string): CSSProperties {
  const border = "4px solid white";
  return {
    position: "absolute",
    width: CORNER_HANDLE,
    height: CORNER_HANDLE,
    borderRadius: 6,
    cursor: `${handle}-resize`,
    filter: "drop-shadow(0 0 1px black) drop-shadow(0 0 2px black)",
    ...(handle.includes("n") ? { top: 0, borderTop: border } : { bottom: 0, borderBottom: border }),
    ...(handle.includes("w") ? { left: 0, borderLeft: border } : { right: 0, borderRight: border }),
  };
}

/**
 * One axis of dragging the graph over the video: its start and size, in
 * fractions of the video area, after its start and/or end edge moved by
 * `delta`. Moving both edges moves the graph.
 */
function dragAxis(pos: number, size: number, delta: number, startEdge: boolean, endEdge: boolean, min: number): [number, number] {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  if (startEdge && endEdge) return [clamp(pos + delta, 0, 1 - size), size];
  if (startEdge) {
    const moved = clamp(pos + delta, 0, pos + size - min);
    return [moved, pos + size - moved];
  }
  if (endEdge) return [pos, clamp(size + delta, min, 1 - pos)];
  return [pos, size];
}

/** Send loop period in ms. */
const TICK_MS = 10;

/** Speed limit of the funscript speed sliders until the user changes it, in percent. */
const DEFAULT_SPEED_LIMIT = 5;

/** Where the machine moves along the depth and stroke sliders; out is towards home. */
const DEPTH_ENDS: [string, string] = ["Out", "In"];
const STROKE_ENDS: [string, string] = ["In", "Out"];

/** The media's time moves on: it plays and is not seeking or waiting for data. */
const advancing = (media: HTMLMediaElement) =>
  !media.paused && !media.seeking && media.readyState >= media.HAVE_FUTURE_DATA && media.playbackRate > 0;

/** The script playhead, in script ms. */
interface Playhead {
  get(): number;
  set(ms: number): void;
}

const isHomed = (state: OssmState | null) => state?.state === "ready" || state?.state === "streaming";

/** Why the machine does not follow the funscript, or `null` when it does. */
function blockReason(
  ossm: Ossm | null,
  state: OssmState | null,
  configured: boolean,
  setupOpen: boolean,
): string | null {
  if (!ossm || !state) return "Connect the OSSM";
  if (ossm.lookahead === 0) return "This firmware cannot stream";
  if (state.state === "homing") return "Homing…";
  if (!isHomed(state)) return "Home the machine";
  if (setupOpen) return "Setting up";
  if (!configured) return "Set depth and stroke";
  if (state.speed <= 0) return "Raise the speed";
  return null;
}

/**
 * A silent WAV covering `ms` of script, the playback clock when there is no
 * video, so playback, seeking and the stream work exactly as with one.
 */
// 3 kB per second (~11 MB per hour of script); write a clock if that ever hurts.
function silence(ms: number): Blob {
  const rate = 3000; // Chrome's lowest sample rate
  const samples = Math.ceil((ms / 1000 + 1) * rate);
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, s: string) => [...s].forEach((c, i) => header.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  header.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  header.setUint32(16, 16, true); // fmt chunk size
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, rate, true);
  header.setUint32(28, rate, true); // bytes per second
  header.setUint16(32, 1, true); // bytes per frame
  header.setUint16(34, 8, true); // bits per sample
  text(36, "data");
  header.setUint32(40, samples, true);
  return new Blob([header, new Uint8Array(samples).fill(128)], { type: "audio/wav" });
}

export default function PlayerPage() {
  const [mode, setMode] = usePersistedState<PlayerMode>("ossm:playerMode", "pattern");
  const { ossm, state, connecting, error, connect, disconnect } = useOssm();
  const videoInput = useRef<HTMLInputElement>(null);
  const scriptInput = useRef<HTMLInputElement>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [silentUrl, setSilentUrl] = useState<string | null>(null);
  const [theater, setTheater] = useState(false);
  const [showGraph, setShowGraph] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const isMobile = useIsMobile();
  const [appearance] = useAppearance();
  /** The always-on-top window the controls float in, over other tabs and applications. */
  const [popout, setPopout] = useState<Window | null>(null);
  const [overlay, setOverlay] = usePersistedState("ossm:playerOverlay", DEFAULT_OVERLAY, localStorage);
  /** Height of the graph below the video, in px. */
  const [graphHeight, setGraphHeight] = usePersistedState("ossm:playerGraphHeight", PREVIEW_HEIGHT, localStorage);
  /** Time both graphs show before and after the video time, in ms. */
  const [graphWindow, setGraphWindow] = usePersistedState("ossm:playerGraphWindow", DEFAULT_WINDOW, localStorage);
  /** Moving and resizing the graph; otherwise clicks go through it to the video. */
  const [arranging, setArranging] = useState(false);
  /** The video area, which the graph's position and size are fractions of. */
  const stageRef = useRef<HTMLDivElement>(null);

  /**
   * Drag `edges` (some of "nsew") of the graph over the video with the pointer;
   * all four move it. It stays inside the video area and at least the minimum size.
   */
  const dragOverlay = (e: PointerEvent<HTMLElement>, edges: string) => {
    e.preventDefault();
    e.stopPropagation();
    const stage = stageRef.current!.getBoundingClientRect();
    const start = overlay;
    const target = e.currentTarget;
    const [startX, startY] = [e.clientX, e.clientY];
    const move = (m: globalThis.PointerEvent) => {
      const dx = (m.clientX - startX) / stage.width;
      const dy = (m.clientY - startY) / stage.height;
      const [x, width] = dragAxis(start.x, start.width, dx, edges.includes("w"), edges.includes("e"), OVERLAY_MIN_WIDTH / stage.width);
      const [y, height] = dragAxis(start.y, start.height, dy, edges.includes("n"), edges.includes("s"), OVERLAY_MIN_HEIGHT / stage.height);
      setOverlay({ ...start, x, y, width, height });
    };
    target.setPointerCapture(e.pointerId);
    target.addEventListener("pointermove", move);
    target.addEventListener("lostpointercapture", () => target.removeEventListener("pointermove", move), { once: true });
  };
  /** Drag the top edge of the graph below the video to set its height; at most most of the window. */
  const dragGraphHeight = (e: PointerEvent<HTMLElement>) => {
    e.preventDefault();
    const start = graphHeight;
    const target = e.currentTarget;
    const startY = e.clientY;
    const move = (m: globalThis.PointerEvent) =>
      setGraphHeight(Math.round(Math.min(Math.max(start - (m.clientY - startY), PREVIEW_MIN_HEIGHT), window.innerHeight * 0.7)));
    target.setPointerCapture(e.pointerId);
    target.addEventListener("pointermove", move);
    target.addEventListener("lostpointercapture", () => target.removeEventListener("pointermove", move), { once: true });
  };
  /** An audio file plays in a bar instead of the video area. */
  const isAudio = !!videoFile?.type.startsWith("audio/");
  /** Theater mode needs a video and a wide screen; closing the video leaves theater mode. */
  const inTheater = theater && !!videoUrl && !isAudio && !isMobile;
  /** The video, or the silent clock without one. */
  const videoRef = useRef<HTMLMediaElement>(null);
  const [paused, setPaused] = useState(true);
  const syncPaused = (e: { currentTarget: HTMLMediaElement }) => setPaused(e.currentTarget.paused);
  const [script, setScript] = useState<Funscript | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [reverse, setReverse] = useState(false);
  const [simplified, setSimplified] = usePersistedState("ossm:playerSimplify", true, localStorage);
  /** Start the media, and with it the script, over at its end; the seek back reopens the stream. */
  const [looped, setLooped] = usePersistedState("ossm:playerLoop", false, localStorage);
  /** Trace the machine's position on the graph as a second line. */
  const [machineLine, setMachineLine] = usePersistedState("ossm:playerMachineLine", false, localStorage);
  /** A minimap of the whole script below the graph. */
  const [minimap, setMinimap] = usePersistedState("ossm:playerMinimap", true, localStorage);
  /** A minimap of the whole script below the video in theater mode. */
  const [theaterMinimap, setTheaterMinimap] = usePersistedState("ossm:playerTheaterMinimap", true, localStorage);
  /** The script as streamed and previewed. */
  const played = useMemo(() => script && simplified ? simplify(script) : script, [script, simplified]);
  /** Sync offset in ms; positive moves the machine earlier. Never sent to the device. */
  const [offset, setOffset] = usePersistedState("ossm:playerOffset", -50);
  /** The offset slider's value while dragged; the offset applies on release. */
  const [offsetDraft, setOffsetDraft] = useState<number | null>(null);
  /** How fast the script plays against the video, which keeps its own speed. */
  const [scriptSpeed, setScriptSpeed] = usePersistedState("ossm:playerScriptSpeed", 1);
  /** The script follows the media's playhead; otherwise it keeps its own and only plays and pauses with the media. */
  const [synced, setSynced] = usePersistedState("ossm:playerSynced", true);
  /**
   * The script's own clock while not synced: script time `at` in ms, moving
   * on at `rate` script ms per ms from `since` (`performance.now()`) while
   * the media advances, else `since` is `null`.
   */
  const clock = useRef<{ at: number; since: number | null; rate: number }>({ at: 0, since: null, rate: 1 });
  const clockTime = () => {
    const { at, since, rate } = clock.current;
    return since === null ? at : at + (performance.now() - since) * rate;
  };
  /** Restart the clock from now, running whenever the media advances. */
  const retimeClock = () => {
    const media = videoRef.current;
    clock.current = {
      at: clockTime(),
      since: media && advancing(media) ? performance.now() : null,
      rate: (media?.playbackRate ?? 1) * scriptSpeed,
    };
  };
  const playhead = useRef<Playhead>(null!);
  playhead.current = synced ? {
    get: () => (videoRef.current?.currentTime ?? 0) * 1000 * scriptSpeed,
    set: (ms) => {
      const media = videoRef.current;
      if (media) media.currentTime = Math.min(Math.max(ms / scriptSpeed / 1000, 0), media.duration || 0);
    },
  } : {
    get: clockTime,
    set: (ms) => {
      clock.current.at = Math.min(Math.max(ms, 0), played ? played.at[played.at.length - 1] : 0);
      if (clock.current.since !== null) clock.current.since = performance.now();
    },
  };
  /** Script time in ms the machine plays at, `offset` ahead of the playhead. */
  const streamTime = () => playhead.current.get() + offset * scriptSpeed;
  /** Script time in ms to put the silent clock back at once it reloads at a new length. */
  const silentResume = useRef<number | null>(null);
  const stream = useRef(new FunscriptStream());
  /** Depth and stroke set since connecting or entering funscript mode. */
  const [configured, setConfigured] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [speedLimit, setSpeedLimit] = usePersistedState("ossm:playerSpeedLimit", DEFAULT_SPEED_LIMIT, localStorage);
  /** Depth and stroke sliders in the controls, changed while playing; kept for the session only, as it risks going too deep. */
  const [depthSliders, setDepthSliders] = usePersistedState("ossm:playerDepthSliders", false);
  const blocked = blockReason(ossm, state, configured, setupOpen);
  /**
   * Why the mode cannot change while it plays, or `null` when it can; the
   * device refuses the switch too. A video the machine does not follow does
   * not lock it.
   */
  const switchLock = mode === "pattern"
    ? (state?.state === "playing" || state?.state === "paused") && "Stop the pattern to switch modes"
    : !paused && !blocked && "Pause playback to switch modes";
  /** A pattern plays or is paused; the machine homed for it. */
  const patternActive = state?.state === "playing" || state?.state === "paused";
  /** Set up to play; only speed and sensation may change on the fly. */
  const ready = !!ossm && ossm.lookahead > 0 && isHomed(state) && configured;

  /** Send `stream:end` if a stream is open. */
  const endStream = (reason: string) => {
    if (!stream.current.end()) return;
    void ossm?.command("stream:end", `(${reason}, media=${Math.round(streamTime())})`);
  };

  // Entering funscript mode (or connecting in it) sends `go:streaming`.
  useEffect(() => {
    if (mode !== "funscript" || !ossm || ossm.lookahead === 0) return;
    void ossm.command("go:streaming");
  }, [mode, ossm]);

  // Depth and stroke may have changed elsewhere (pattern mode, another remote).
  useEffect(() => {
    setConfigured(false);
    setSetupOpen(false);
  }, [ossm, mode]);

  // The machine rests at home after homing; a depth of 0 starts the depth setup from there.
  const lastState = useRef(state?.state);
  useEffect(() => {
    if (mode === "funscript" && lastState.current === "homing" && isHomed(state)) void ossm?.command("set:depth:0");
    lastState.current = state?.state;
  }, [mode, ossm, state]);

  // The setup's speed limit also holds for a speed raised while playing or a lowered limit.
  useEffect(() => {
    if (setupOpen && ossm && state && state.speed > speedLimit) void ossm.command(`set:speed:${speedLimit}`);
  }, [setupOpen, ossm, state, speedLimit]);

  // A disconnect closes the stream (nothing to send it to) and pauses the video.
  useEffect(() => {
    if (!ossm) return;
    const onDisconnect = () => {
      stream.current.end();
      videoRef.current?.pause();
    };
    ossm.addEventListener("disconnect", onDisconnect);
    return () => ossm.removeEventListener("disconnect", onDisconnect);
  }, [ossm]);

  // The video plays on without the machine; the machine stops once it is blocked.
  useEffect(() => {
    if (mode === "funscript" && blocked) endStream(blocked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, blocked]);

  /** Pause the video and the machine, then ask for depth and stroke. */
  const openSetup = () => {
    videoRef.current?.pause();
    endStream("setup");
    setSetupOpen(true);
  };

  // The send loop. It keeps running, throttled, in background tabs. A stream
  // starts on the first tick while the video actually plays, so after an end
  // that does not stop playback (rate, script) the next one starts
  // right away.
  useEffect(() => {
    if (mode !== "funscript" || paused || blocked || !ossm || !played) return;
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video || !advancing(video)) return;
      for (const p of stream.current.tick(played, streamTime(), video.playbackRate * scriptSpeed, reverse, ossm.lookahead)) {
        void ossm.streamPoint(p.position, p.duration);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [mode, paused, blocked, ossm, played, offset, scriptSpeed, synced, reverse]);

  // Video events that matter; in funscript mode all but `playing` end the stream.
  const videoEvent = (e: SyntheticEvent<HTMLMediaElement>) => {
    log(`video ${e.type}`);
    retimeClock();
    if (mode === "funscript" && e.type !== "playing") endStream(e.type);
  };

  useEffect(() => {
    setVideoUrl(null);
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  const silentMs = mode === "funscript" && !videoFile && script ? script.at[script.at.length - 1] / scriptSpeed : null;
  useEffect(() => {
    setSilentUrl(null);
    if (silentMs == null) return;
    const url = URL.createObjectURL(silence(silentMs));
    setSilentUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [silentMs]);

  /** Before the silent clock unmounts: its events no longer reach React then. */
  const dropSilence = (reason: string) => {
    if (!silentUrl) return;
    endStream(reason);
    setPaused(true);
  };

  const loadScript = async (file: File) => {
    try {
      const parsed = await readFunscript(file);
      endStream("script");
      setScript(parsed);
      setScriptError(null);
    } catch (e) {
      setScriptError((e as Error).message);
    }
  };

  /** Load a script the editor sent, `raw` from `SENT_SCRIPT_KEY`. */
  const loadSent = (raw: string | null) => {
    if (!raw) return;
    try {
      const parsed = parseFunscript((JSON.parse(raw) as { name: string }).name, raw);
      endStream("script");
      setScript(parsed);
      setScriptError(null);
    } catch (e) {
      setScriptError((e as Error).message);
    }
  };
  // A sent script loads on opening the page, once, and at once from editors in other tabs.
  useEffect(() => {
    const raw = localStorage.getItem(SENT_SCRIPT_KEY);
    localStorage.removeItem(SENT_SCRIPT_KEY);
    loadSent(raw);
  }, []);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === SENT_SCRIPT_KEY && loadSent(e.newValue);
    addEventListener("storage", onStorage);
    return () => removeEventListener("storage", onStorage);
  });

  /** Show and hide the controls pane in theater mode; in the pane while it is shown. */
  const theaterToggles = (style?: CSSProperties) => (
    <Flex gap="2" style={style}>
      <IconButton
        variant="surface"
        aria-label={showControls ? "Hide controls" : "Show controls"}
        onClick={() => setShowControls(!showControls)}
      >
        <HamburgerMenuIcon />
      </IconButton>
    </Flex>
  );

  const openPopout = async () => {
    const win = await window.documentPictureInPicture!.requestWindow(POPOUT_SIZE);
    // The page's styles: <style>s in dev, <link>s in builds.
    for (const sheet of document.styleSheets) {
      win.document.head.append(sheet.href
        ? Object.assign(win.document.createElement("link"), { rel: "stylesheet", href: sheet.href })
        : Object.assign(win.document.createElement("style"), { textContent: sheet.ownerNode?.textContent ?? "" }));
    }
    win.document.body.style.margin = "0";
    win.addEventListener("pagehide", () => setPopout(null), { once: true });
    setPopout(win);
  };
  // Leaving the page takes the controls with it.
  useEffect(() => () => popout?.close(), [popout]);

  /** The Funscript and Graph sections of the controls show only their titles until expanded. */
  const [funscriptOpen, setFunscriptOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  /** A section's title, pressed to expand or collapse it. */
  const sectionHeader = (title: string, open: boolean, setOpen: (open: boolean) => void) => (
    <Flex
      align="center"
      gap="2"
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen(!open)}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(!open))}
      style={{ cursor: "pointer", userSelect: "none" }}
    >
      <ChevronRightIcon style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined }} />
      <Heading size="3">{title}</Heading>
    </Flex>
  );

  const media = videoUrl || silentUrl;
  const controls = (inPopout: boolean) => (
    <>
      <Flex p="3" pb="0" gap="2">
        <Tooltip content={switchLock} open={switchLock ? undefined : false} container={inPopout ? popout?.document.body : undefined}>
          <Box flexGrow="1">
            <SegmentedControl.Root
              value={mode}
              disabled={!!switchLock}
              onValueChange={(v) => {
                log(`mode ${v}`);
                dropSilence("mode");
                // Leaving funscript mode leaves streaming (any remote's), so patterns can play;
                // the switch is locked while the stream runs, so none of ours is open.
                if (v === "pattern" && state?.state === "streaming") void ossm?.command("go:menu");
                setMode(v as PlayerMode);
              }}
              // Disabled buttons swallow hover, so the tooltip listens on the box.
              style={{ width: "100%", pointerEvents: switchLock ? "none" : undefined }}
            >
              <SegmentedControl.Item value="pattern">Pattern</SegmentedControl.Item>
              <SegmentedControl.Item value="funscript">Funscript</SegmentedControl.Item>
            </SegmentedControl.Root>
          </Box>
        </Tooltip>
        {!inPopout && window.documentPictureInPicture && !isMobile && (
          <IconButton variant="soft" color="gray" aria-label="Pop out controls" title="Pop out controls" onClick={() => void openPopout()}>
            <OpenInNewWindowIcon />
          </IconButton>
        )}
      </Flex>
      <Flex direction="column" gap="3" p="3">
        {inPopout && media && (
          <Button variant="soft" onClick={() => (paused ? void videoRef.current?.play() : videoRef.current?.pause())}>
            {paused ? <><PlayIcon /> Play</> : <><PauseIcon /> Pause</>}
          </Button>
        )}
        {mode === "funscript" && <Heading size="3">Machine</Heading>}
        {!navigator.bluetooth ? (
          <Text size="2" color="gray">
            Web Bluetooth is not supported in this browser (use Chrome or Edge).
          </Text>
        ) : ossm ? (
          <>
            <Flex align="center" justify="between" gap="2">
              <Flex direction="column">
                <Text size="2" weight="medium">{ossm.name}</Text>
                <Text size="1" color="gray">{state?.state ?? "…"}</Text>
              </Flex>
              <Button variant="soft" onClick={disconnect}>Disconnect</Button>
            </Flex>
            {!isHomed(state) && !(mode === "pattern" && patternActive) && (
              <Button
                loading={state?.state === "homing"}
                onClick={() => {
                  endStream("home");
                  void ossm.command("go:home");
                }}
              >
                <HomeIcon /> Home
              </Button>
            )}
          </>
        ) : (
          <Button loading={connecting} onClick={() => void connect()}>
            Connect
          </Button>
        )}
        {error && (
          <Callout.Root color="red" size="1">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        {mode === "pattern" && ossm && state && (isHomed(state) || patternActive) && (
          <>
            <Separator size="4" />
            <PatternControls ossm={ossm} state={state} />
          </>
        )}
        {mode === "funscript" && (
          <>
            {ossm && ossm.lookahead === 0 ? (
              <Text size="2" color="gray">This firmware cannot stream.</Text>
            ) : ossm && state && isHomed(state) && (
              !configured ? (
                <Button onClick={openSetup}>Set depth and stroke</Button>
              ) : <>
                <SettingSlider ossm={ossm} setting="speed" label="Speed" value={state.speed} />
                <SettingSlider ossm={ossm} setting="sensation" label="Sensation" value={state.sensation} ends={["Smooth", "Hard"]} />
                {depthSliders && <>
                  <SettingSlider ossm={ossm} setting="depth" label="Depth" value={state.depth} ends={DEPTH_ENDS} />
                  <SettingSlider ossm={ossm} setting="stroke" label="Stroke" value={state.stroke} ends={STROKE_ENDS} />
                </>}
                <Button variant="soft" onClick={openSetup}>
                  Depth {state.depth.toFixed(0)}% · Stroke {state.stroke.toFixed(0)}%
                </Button>
                <Text size="2" color="gray">
                  {blocked ?? (state.state === "ready" ? "Ready" : "Streaming")}
                </Text>
              </>
            )}
            {setupOpen && ossm && state && (
              <SetupDialog
                ossm={ossm}
                state={state}
                speedLimit={speedLimit}
                setSpeedLimit={setSpeedLimit}
                depthSliders={depthSliders}
                setDepthSliders={setDepthSliders}
                onDone={() => setConfigured(true)}
                onClose={() => setSetupOpen(false)}
              />
            )}
            {ready && (
              <LabeledSlider
                label="Sync offset"
                value={offsetDraft ?? offset}
                display={`${(offsetDraft ?? offset) > 0 ? "+" : ""}${offsetDraft ?? offset} ms`}
                min={-500}
                max={500}
                step={5}
                onChange={setOffsetDraft}
                onCommit={(v) => {
                  // The queued points are timed from the old offset; the next tick opens a stream at the new one.
                  endStream("offset");
                  setOffsetDraft(null);
                  setOffset(v);
                }}
              />
            )}
            {ready && media && (
              <Button variant="soft" onClick={() => (paused ? void videoRef.current?.play() : videoRef.current?.pause())}>
                {paused ? <><PlayIcon /> Play</> : <><PauseIcon /> Pause</>}
              </Button>
            )}
            {ready && (
              <Button
                variant="soft"
                color="red"
                size="3"
                style={{ height: 64 }}
                onClick={() => {
                  videoRef.current?.pause();
                  endStream("stop");
                  void ossm.command("go:menu");
                }}
              >
                <StopIcon /> Stop
              </Button>
            )}
            <Separator size="4" />
            {sectionHeader("Funscript", funscriptOpen, setFunscriptOpen)}
            {funscriptOpen && <>
              <LabeledSlider
                label="Script speed"
                value={scriptSpeed}
                display={`x${scriptSpeed}`}
                min={0.25}
                max={2}
                step={0.05}
                disabled={!paused}
                onChange={(v) => {
                  // The silent clock's length follows the speed; keep the playhead at the same script time.
                  if (silentUrl) silentResume.current ??= (videoRef.current?.currentTime ?? 0) * 1000 * scriptSpeed;
                  setScriptSpeed(Math.round(v * 100) / 100);
                }}
              />
              <Text as="label" size="2" weight="medium">
                <Flex align="center" justify="between" gap="2">
                  Reverse
                  <Switch checked={reverse} disabled={!paused} onCheckedChange={setReverse} />
                </Flex>
              </Text>
              <Text as="label" size="2" weight="medium">
                <Flex align="center" justify="between" gap="2">
                  Simplify
                  <Switch checked={simplified} disabled={!paused} onCheckedChange={setSimplified} />
                </Flex>
              </Text>
              <Text as="label" size="2" weight="medium">
                <Flex align="center" justify="between" gap="2">
                  Sync with media
                  <Switch
                    checked={synced}
                    disabled={!paused}
                    onCheckedChange={(on) => {
                      // The script's own playhead starts where the media's left it.
                      if (!on) clock.current = { at: playhead.current.get(), since: null, rate: 1 };
                      setSynced(on);
                    }}
                  />
                </Flex>
              </Text>
              <Text as="label" size="2" weight="medium">
                <Flex align="center" justify="between" gap="2">
                  Loop
                  <Switch checked={looped} onCheckedChange={setLooped} />
                </Flex>
              </Text>
            </>}
            <Separator size="4" />
            {sectionHeader("Graph", graphOpen, setGraphOpen)}
            {graphOpen && <>
              {inTheater && (
                <Text as="label" size="2" weight="medium">
                  <Flex align="center" justify="between" gap="2">
                    Show graph
                    <Switch checked={showGraph} onCheckedChange={setShowGraph} />
                  </Flex>
                </Text>
              )}
              <Text as="label" size="2" weight="medium">
                <Flex align="center" justify="between" gap="2">
                  Show minimap
                  <Switch checked={inTheater ? theaterMinimap : minimap} onCheckedChange={inTheater ? setTheaterMinimap : setMinimap} />
                </Flex>
              </Text>
              {(!inTheater || showGraph) && (
                <>
                  <LabeledSlider
                    label="Line width"
                    value={overlay.lineWidth}
                    display={`${overlay.lineWidth} px`}
                    min={1}
                    max={8}
                    step={0.5}
                    onChange={(lineWidth) => setOverlay({ ...overlay, lineWidth })}
                  />
                  <Text as="label" size="2" weight="medium">
                    <Flex align="center" justify="between" gap="2">
                      Show machine line
                      <Switch checked={machineLine} onCheckedChange={setMachineLine} />
                    </Flex>
                  </Text>
                  <LabeledSlider
                    label="Before playhead"
                    value={graphWindow.before}
                    display={`${graphWindow.before / 1000} s`}
                    min={0}
                    max={10000}
                    step={1000}
                    onChange={(before) => setGraphWindow({ ...graphWindow, before })}
                  />
                  <LabeledSlider
                    label="After playhead"
                    value={Math.max(AFTER_STOPS.findIndex((s) => s * 1000 >= graphWindow.after), 0)}
                    display={`${graphWindow.after / 1000} s`}
                    min={0}
                    max={AFTER_STOPS.length - 1}
                    step={1}
                    onChange={(i) => setGraphWindow({ ...graphWindow, after: AFTER_STOPS[i] * 1000 })}
                  />
                  {inTheater ? (
                    <>
                      <LabeledSlider
                        label="Background"
                        value={overlay.background}
                        display={`${overlay.background}%`}
                        min={0}
                        max={100}
                        step={5}
                        onChange={(background) => setOverlay({ ...overlay, background })}
                      />
                      <Button variant="soft" disabled={!played} onClick={() => setArranging(true)}>
                        <MoveIcon /> Move and resize
                      </Button>
                    </>
                  ) : (
                    <Text size="1" color="gray">Drag the top edge of the graph to change its height.</Text>
                  )}
                  <Button
                    variant="soft"
                    color="gray"
                    onClick={() => {
                      setOverlay(DEFAULT_OVERLAY);
                      setGraphHeight(PREVIEW_HEIGHT);
                      setGraphWindow(DEFAULT_WINDOW);
                    }}
                  >
                    Reset
                  </Button>
                </>
              )}
            </>}
          </>
        )}
      </Flex>
    </>
  );

  // The controls live in one place at a time, so dialogs and pending slider values are not doubled.
  const sidebar = (
    <>
      {inTheater && theaterToggles({ padding: "var(--space-3)", paddingBottom: 0 })}
      {popout ? (
        <Flex direction="column" gap="3" p="3">
          <Text size="2" color="gray">The controls are in the popout window.</Text>
          <Button variant="soft" onClick={() => popout.close()}>Bring back</Button>
          {createPortal(
            <Theme accentColor="purple" radius="large" appearance={appearance} hasBackground style={{ minHeight: "100vh" }}>
              <PortalContainer.Provider value={popout.document.body}>{controls(true)}</PortalContainer.Provider>
            </Theme>,
            popout.document.body,
          )}
        </Flex>
      ) : controls(false)}
    </>
  );

  const mediaProps = {
    ref: (el: HTMLMediaElement | null) => void (videoRef.current = el),
    controls: true,
    loop: mode === "funscript" && looped,
    onPlay: syncPaused,
    onPause: (e) => {
      syncPaused(e);
      videoEvent(e);
    },
    onEmptied: (e) => {
      syncPaused(e);
      videoEvent(e);
    },
    onPlaying: videoEvent,
    onSeeking: videoEvent,
    onSeeked: retimeClock,
    onWaiting: videoEvent,
    onRateChange: videoEvent,
    onEnded: videoEvent,
  } satisfies MediaHTMLAttributes<HTMLMediaElement> & { ref: unknown };

  const content = (
    <Flex direction="column" gap="3" p={inTheater ? "0" : "3"} height="100%">
      <input
        ref={videoInput}
        type="file"
        accept="video/*,audio/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            dropSilence("video");
            // Switching between video and audio swaps the element, whose events then never reach React.
            endStream("video");
            setPaused(true);
            setVideoFile(file);
          }
          e.target.value = "";
        }}
      />
      <input
        ref={scriptInput}
        type="file"
        accept=".funscript"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void loadScript(file);
          e.target.value = "";
        }}
      />
      {videoUrl ? (
        <>
          {!inTheater && <Flex align="center" justify="between" gap="2">
            <Text size="2" weight="medium" truncate title={videoFile?.name}>{videoFile?.name}</Text>
            <Flex gap="2">
              {!isMobile && !isAudio && (
                <Button variant="soft" onClick={() => setTheater(true)}>
                  <EnterFullScreenIcon /> Theater
                </Button>
              )}
              <Button variant="soft" onClick={() => videoInput.current?.click()}>
                <UploadIcon /> Open
              </Button>
              <Button
                variant="soft"
                color="gray"
                onClick={() => {
                  // The video unmounts, so its pause and emptied events never reach React.
                  endStream("close");
                  setPaused(true);
                  setVideoFile(null);
                }}
              >
                <Cross2Icon /> Close
              </Button>
            </Flex>
          </Flex>}
          {isAudio ? (
            <audio {...mediaProps} src={videoUrl} style={{ width: "100%", flexShrink: 0 }} />
          ) : (
            /* The video stays at this place in the tree, so toggling theater mode does not reload it. */
            <Box ref={stageRef} position="relative" flexGrow="1" minHeight="0">
              <video {...mediaProps} src={videoUrl} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "black" }} />
              {inTheater && mode === "funscript" && played && showGraph && (
                // While arranging, drag the graph to move it and its handles to resize it; otherwise
                // clicks go through to the video. Done sits in its middle, clear of the handles.
                <Box
                  position="absolute"
                  style={{
                    left: `${overlay.x * 100}%`,
                    top: `${overlay.y * 100}%`,
                    width: `${overlay.width * 100}%`,
                    height: `${overlay.height * 100}%`,
                    ...(arranging
                      ? { cursor: "move", borderRadius: 6, outline: "2px dashed white", boxShadow: "0 0 0 3px rgba(0,0,0,0.5)" }
                      : { pointerEvents: "none" }),
                  }}
                  onPointerDown={(e) => dragOverlay(e, "nsew")}
                >
                  <ScriptPreview script={played} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} ossm={ossm} machineLine={machineLine} notice={blocked} lineWidth={overlay.lineWidth} span={graphWindow} overlay={overlay} />
                  {arranging &&
                    RESIZE_HANDLES.map((h) => <Box key={h} title="Drag to resize" style={handleStyle(h)} onPointerDown={(e) => dragOverlay(e, h)} />)}
                  {/* Stops the pointer here, so pressing Done does not start a drag. */}
                  {arranging && (
                    <Box
                      position="absolute"
                      style={{ left: "50%", top: "50%", translate: "-50% -50%", cursor: "auto" }}
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      <Button onClick={() => setArranging(false)}>
                        <CheckIcon /> Done
                      </Button>
                    </Box>
                  )}
                </Box>
              )}
              {/* Where the hidden pane would appear, at the pane's padding so they do not jump. */}
              {inTheater && !showControls && theaterToggles({ position: "absolute", left: "var(--space-3)", top: "var(--space-3)" })}
              {inTheater && (
                <Button
                  variant="surface"
                  onClick={() => setTheater(false)}
                  style={{ position: "absolute", top: "var(--space-3)", right: "var(--space-3)" }}
                >
                  <ExitFullScreenIcon /> Exit
                </Button>
              )}
            </Box>
          )}
          {inTheater && mode === "funscript" && played && theaterMinimap && (
            <ScriptMinimap script={played} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} span={graphWindow} />
          )}
        </>
      ) : (
        <Flex direction="column" align="center" justify="center" gap="3" flexGrow="1">
          <Text size="2" color="gray">
            {mode === "funscript" ? "Open a video or audio file to play it with the funscript." : "Open a video or audio file to play it here."}
          </Text>
          <Button variant="soft" onClick={() => videoInput.current?.click()}>
            <UploadIcon /> Open media
          </Button>
        </Flex>
      )}
      {silentUrl && <audio
        {...mediaProps}
        src={silentUrl}
        onLoadedMetadata={(e) => {
          if (silentResume.current === null) return;
          e.currentTarget.currentTime = silentResume.current / 1000 / scriptSpeed;
          silentResume.current = null;
        }}
        style={{ width: "100%", flexShrink: 0 }} />}
      {mode === "funscript" && scriptError && (
        <Callout.Root color="red" size="1">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{scriptError}</Callout.Text>
        </Callout.Root>
      )}
      {mode === "funscript" && !inTheater &&
        (script && played ? (
          <>
            <Flex align="center" justify="between" gap="2">
              <Text size="2" weight="medium" truncate title={script.name}>{script.name}</Text>
              <Flex gap="2">
                <Button variant="soft" onClick={() => scriptInput.current?.click()}>
                  <UploadIcon /> Open
                </Button>
                <Button
                  variant="soft"
                  color="gray"
                  onClick={() => {
                    dropSilence("close");
                    endStream("close");
                    setScript(null);
                    setScriptError(null);
                  }}
                >
                  <Cross2Icon /> Close
                </Button>
              </Flex>
            </Flex>
            <Box position="relative" flexShrink="0">
              <ScriptPreview script={played} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} ossm={ossm} machineLine={machineLine} notice={blocked} lineWidth={overlay.lineWidth} span={graphWindow} height={graphHeight} />
              <Box
                title="Drag to resize"
                style={{
                  position: "absolute",
                  top: 0,
                  left: "calc(50% - 20px)",
                  width: 40,
                  height: 12,
                  borderTop: "4px solid var(--gray-a8)",
                  cursor: "ns-resize",
                  touchAction: "none",
                }}
                onPointerDown={dragGraphHeight}
              />
            </Box>
            {minimap && <ScriptMinimap script={played} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} span={graphWindow} />}
          </>
        ) : (
          <Flex align="center" justify="center" flexShrink="0" height={`${graphHeight}px`} style={{ borderRadius: 6, background: "var(--gray-a2)" }}>
            <Button variant="soft" onClick={() => scriptInput.current?.click()}>
              <UploadIcon /> Open funscript
            </Button>
          </Flex>
        ))}
    </Flex>
  );

  // Theater mode pins the page to the window. No z-index, so dialogs and
  // menus, portalled to the end of the body, still open above it.
  return (
    <div
      style={inTheater
        ? { position: "fixed", inset: 0, display: "flex", flexDirection: "column", background: "var(--color-background)" }
        : { display: "contents" }}
    >
      <GraphLayout sidebar={sidebar} content={content} sidebarHidden={inTheater && !showControls} />
    </div>
  );
}

/** Pattern mode: play, adjust and stop the device's patterns. */
function PatternControls({ ossm, state }: {
  ossm: Ossm;
  state: OssmState;
}) {
  const [patterns, setPatterns] = useState<PatternInfo[]>([]);
  const [description, setDescription] = useState("");
  const active = state.state === "playing" || state.state === "paused";
  const selected = active ? state.pattern : null;

  useEffect(() => {
    let current = true;
    ossm.readPatterns().then(
      (list) => current && setPatterns(list),
      (e) => log(`reading patterns failed: ${e}`, "error"),
    );
    return () => void (current = false);
  }, [ossm]);

  useEffect(() => {
    setDescription("");
    if (selected == null) return;
    let current = true;
    ossm.readDescription(selected).then(
      (text) => current && setDescription(text),
      (e) => log(`reading description ${selected} failed: ${e}`, "error"),
    );
    return () => void (current = false);
  }, [ossm, selected]);

  const container = useContext(PortalContainer);
  return (
    <>
      <Box>
        <Text size="2" weight="medium" mb="1" as="div">Pattern</Text>
        <Select.Root
          value={selected == null ? "" : String(selected)}
          onValueChange={(v) => void ossm.command(`set:pattern:${v}`)}
        >
          <Select.Trigger placeholder="Choose a pattern" style={{ width: "100%" }} />
          <Select.Content container={container}>
            {patterns.map((p) => (
              <Select.Item key={p.idx} value={String(p.idx)}>{p.name}</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        {description && <Text size="1" color="gray" as="p" mt="1">{description}</Text>}
      </Box>
      <SettingSlider ossm={ossm} setting="depth" label="Depth" value={state.depth} ends={DEPTH_ENDS} />
      <SettingSlider ossm={ossm} setting="stroke" label="Stroke" value={state.stroke} ends={STROKE_ENDS} />
      <SettingSlider ossm={ossm} setting="speed" label="Speed" value={state.speed} />
      <SettingSlider ossm={ossm} setting="sensation" label="Sensation" value={state.sensation} />
      <Button
        variant="soft"
        disabled={state.speed <= 0}
        onClick={() => void ossm.command("set:speed:0")}
      >
        <PauseIcon /> Pause
      </Button>
      <Button
        variant="soft"
        color="red"
        size="3"
        style={{ height: 64 }}
        onClick={() => void ossm.command("go:menu")}
      >
        <StopIcon /> Stop
      </Button>
    </>
  );
}

/**
 * A device setting (0–100). Follows the device's value, except that it shows
 * the user's latest value for a while after a change, so state reported
 * before the device applied it does not make the slider jump back. Only user
 * changes are written.
 */
function SettingSlider({ ossm, setting, label, value, max = 100, disabled, ends, onChange }: {
  ossm: Ossm;
  setting: string;
  label: string;
  value: number;
  max?: number;
  disabled?: boolean;
  ends?: [string, string];
  /** Called after each write is queued. */
  onChange?: () => void;
}) {
  const [pending, setPending] = useState<number | null>(null);
  const timer = useRef<number>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const shown = pending ?? value;

  return (
    <LabeledSlider
      label={label}
      value={shown}
      display={shown.toFixed(1)}
      min={0}
      max={max}
      step={0.1}
      disabled={disabled}
      ends={ends}
      onChange={(v) => {
        const rounded = Math.round(v * 10) / 10;
        setPending(rounded);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPending(null), PENDING_MS);
        void ossm.command(`set:${setting}:${rounded}`);
        onChange?.();
      }}
    />
  );
}

/** The speed setting up to `limit`, with a dialog to change the limit. */
function SpeedSlider({ ossm, value, limit, setLimit }: {
  ossm: Ossm;
  value: number;
  limit: number;
  setLimit: (limit: number) => void;
}) {
  const container = useContext(PortalContainer);
  return (
    <Flex align="end" gap="2">
      <Box flexGrow="1">
        <SettingSlider ossm={ossm} setting="speed" label={`Speed (max ${limit}%)`} value={value} max={limit} />
      </Box>
      <Dialog.Root>
        <Dialog.Trigger>
          <IconButton variant="soft" color="gray" aria-label="Speed limit">
            <GearIcon />
          </IconButton>
        </Dialog.Trigger>
        <Dialog.Content maxWidth="360px" container={container}>
          <Dialog.Title>Speed limit</Dialog.Title>
          <Dialog.Description size="2" mb="4">
            The highest speed the speed slider allows. Raise it once the machine moves as expected.
          </Dialog.Description>
          <LabeledSlider label="Limit" value={limit} display={`${limit}%`} min={1} max={100} step={1} onChange={setLimit} />
          <Flex justify="end" mt="4">
            <Dialog.Close>
              <Button>Done</Button>
            </Dialog.Close>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Flex>
  );
}

/**
 * Sets the depth and the stroke while the machine follows them. A change
 * streams one point to the end it sets, the deep end (depth) or the shallow
 * end (stroke), unless the machine already heads there; the firmware
 * re-requests the last point whenever the stroke range changes. Changes wait
 * for a speed above zero, so the machine moves no faster than the speed shown.
 * Done returns the machine to the stroke end.
 */
function SetupDialog({ ossm, state, speedLimit, setSpeedLimit, depthSliders, setDepthSliders, onDone, onClose }: {
  ossm: Ossm;
  state: OssmState;
  speedLimit: number;
  setSpeedLimit: (limit: number) => void;
  /** Depth and stroke sliders in the controls. */
  depthSliders: boolean;
  setDepthSliders: (on: boolean) => void;
  onDone: () => void;
  onClose: () => void;
}) {
  /** Depth and stroke of the last setup done, shown for reference. */
  const [last, setLast] = usePersistedState<{ depth: number; stroke: number } | null>("ossm:playerLastSetup", null, localStorage);
  /** The stream position last sent while the speed was above zero: 0 (deep end) or 100 (shallow end). */
  const tracking = useRef<number | null>(null);
  // At speed zero the firmware holds and resumes only with the next point.
  useEffect(() => {
    if (state.speed <= 0) tracking.current = null;
  }, [state.speed]);

  const track = (position: number) => {
    if (tracking.current === position) return;
    tracking.current = position;
    void ossm.streamPoint(position, 0, "(setup)");
  };

  /** End the tracking stream, the machine stays where it is. */
  const close = () => {
    if (tracking.current !== null) void ossm.command("stream:end", "(setup)");
    tracking.current = null;
    onClose();
  };

  const still = state.speed <= 0;
  const container = useContext(PortalContainer);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Content maxWidth="420px" container={container}>
        <Dialog.Title>Set depth and stroke</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          The machine follows the slider you move. Depth is the deepest point while playing; 100% extends the
          machine fully. Stroke sets the shallowest point.
        </Dialog.Description>
        <Flex direction="column" gap="3">
          <SpeedSlider ossm={ossm} value={state.speed} limit={speedLimit} setLimit={setSpeedLimit} />
          <SettingSlider ossm={ossm} setting="depth" label="Depth" value={state.depth} ends={DEPTH_ENDS} disabled={still} onChange={() => track(0)} />
          <SettingSlider ossm={ossm} setting="stroke" label="Stroke" value={state.stroke} ends={STROKE_ENDS} disabled={still} onChange={() => track(100)} />
          <Flex gap="2">
            <Button variant="soft" disabled={still} style={{ flex: 1 }} onClick={() => track(0)}>
              Move to depth
            </Button>
            <Button variant="soft" disabled={still} style={{ flex: 1 }} onClick={() => track(100)}>
              Move to stroke
            </Button>
          </Flex>
          {/* Deliberately no button to apply these: the machine would jump to them, and a
              value from another session or setup may be too deep, which risks injury. */}
          {last && (
            <Text size="2" color="gray">
              Last set: depth {last.depth.toFixed(1)}%, stroke {last.stroke.toFixed(1)}%
            </Text>
          )}
          {still && (
            <Text size="2" color="gray">Raise the speed to change depth and stroke; the machine moves at that speed.</Text>
          )}
        </Flex>
        <Flex justify="between" gap="2" mt="4">
          {depthSliders ? (
            <Button variant="soft" color="gray" onClick={() => setDepthSliders(false)}>
              Hide sliders in controls
            </Button>
          ) : (
            <AlertDialog.Root>
              <AlertDialog.Trigger>
                <Button variant="soft" color="gray">Show sliders in controls</Button>
              </AlertDialog.Trigger>
              <AlertDialog.Content maxWidth="400px" container={container}>
                <AlertDialog.Title>Change depth while playing?</AlertDialog.Title>
                <AlertDialog.Description size="2">
                  The script plays between depth and stroke, so a depth that feels right in a shallow part of the
                  script goes that much deeper once the script does. Raise it only a little at a time. The sliders
                  stay until you close the browser.
                </AlertDialog.Description>
                <Flex gap="3" mt="4" justify="end">
                  <AlertDialog.Cancel>
                    <Button variant="soft" color="gray">Cancel</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action>
                    <Button color="red" onClick={() => setDepthSliders(true)}>Show sliders</Button>
                  </AlertDialog.Action>
                </Flex>
              </AlertDialog.Content>
            </AlertDialog.Root>
          )}
          <Button
            onClick={() => {
              setLast({ depth: state.depth, stroke: state.stroke });
              onDone();
              // Start playing from the shallow end; the stream stays open so the machine gets there.
              if (still) close();
              else {
                track(100);
                onClose();
              }
            }}
          >
            Done
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** Time constant, in ms, of the machine dot easing toward the notified position; higher is smoother but lags more. */
const MACHINE_SMOOTHING_MS = 60;
/** How often the firmware samples the machine position; it notifies only changes, so a longer gap means it held. */
const POSITION_INTERVAL_MS = 100;

/**
 * The script's raw points around the video time, redrawn every animation
 * frame. Works without a video (time 0). `notice` says why the machine does
 * not follow. The machine's planned position is a dot on the playhead, and
 * with `machineLine` also a line trailing it.
 */
function ScriptPreview({ script, speed, playhead, reverse, videoRef, ossm, machineLine, notice, lineWidth, span: { before, after }, height: cssHeight, overlay }: {
  script: Funscript;
  /** Script time per video time; the script's points show at their video time. */
  speed: number;
  playhead: RefObject<Playhead>;
  reverse: boolean;
  videoRef: RefObject<HTMLMediaElement | null>;
  ossm: Ossm | null;
  machineLine: boolean;
  notice: string | null;
  lineWidth: number;
  /** Time shown before and after the video time, in ms. */
  span: { before: number; after: number };
  /** In px; without, the graph fills its parent. */
  height?: number;
  /** Drawn over the video in this style, filling its parent, with colors for a dark backdrop. */
  overlay?: OverlayStyle;
}) {
  const overlaid = !!overlay;
  const [appearance] = useAppearance();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(canvasRef.current!);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (width === 0 || height === 0) return;
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const isDark = overlaid || appearance === "dark";
    const gridColor = isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.15)";
    const playheadColor = isDark ? "rgba(255,255,255,0.9)" : "rgba(0,0,0,0.7)";
    const lineColor = "#ec4899";
    const machineColor = "#22d3ee";
    const pad = 6;
    const y = (pos: number) => pad + (1 - (reverse ? 100 - pos : pos) / 100) * (height - 2 * pad);

    let frame = 0;
    // The machine position eases toward each 100 ms sample instead of jumping.
    let machine: number | null = null;
    let drawnAt = performance.now();
    // The notified machine positions, at the video times in ms they arrived, for the machine line.
    const trail: { at: number[]; pos: number[] } = { at: [], pos: [] };
    const record = () => {
      const now = playhead.current.get() / speed;
      const pos = ossm?.streamPosition() ?? null;
      // Seeking back starts the trail over.
      if (now < trail.at[trail.at.length - 1]) trail.at.length = trail.pos.length = 0;
      const last = trail.at.length - 1;
      if (pos === null || now === trail.at[last]) return;
      if (now - POSITION_INTERVAL_MS > trail.at[last]) {
        trail.at.push(now - POSITION_INTERVAL_MS);
        trail.pos.push(trail.pos[last]);
      }
      trail.at.push(now);
      trail.pos.push(pos);
    };
    if (machineLine) ossm?.addEventListener("position", record);
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const elapsed = performance.now() - drawnAt;
      drawnAt += elapsed;
      const now = playhead.current.get() / speed;
      const from = now - before;
      const to = now + after;
      const x = (at: number) => ((at - from) / (to - from)) * width;
      const sx = (i: number) => x(script.at[i] / speed);
      ctx.clearRect(0, 0, width, height);

      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const pos of [0, 50, 100]) {
        const py = Math.round(y(pos)) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(width, py);
      }
      ctx.stroke();

      // The points in the window and one beyond each edge, so the line reaches the edges.
      const first = Math.max(bisectLeft(script.at, from * speed) - 1, 0);
      let last = first;
      while (last < script.at.length - 1 && script.at[last] <= to * speed) last++;
      ctx.strokeStyle = lineColor;
      ctx.fillStyle = lineColor;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = first; i <= last; i++) ctx.lineTo(sx(i), y(script.pos[i]));
      ctx.stroke();
      for (let i = first; i <= last; i++) {
        ctx.beginPath();
        ctx.arc(sx(i), y(script.pos[i]), lineWidth + 1, 0, Math.PI * 2);
        ctx.fill();
      }

      // Over the video, a dark halo keeps the playhead visible on bright frames.
      const px = Math.round(x(now));
      ctx.strokeStyle = playheadColor;
      ctx.lineWidth = 2;
      if (overlaid) {
        ctx.shadowColor = "black";
        ctx.shadowBlur = 4;
      }
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
      ctx.shadowBlur = 0;

      const target = ossm?.streamPosition() ?? null;
      machine = target === null || machine === null ? target : machine + (target - machine) * (1 - Math.exp(-elapsed / MACHINE_SMOOTHING_MS));
      if (now < trail.at[trail.at.length - 1]) trail.at.length = trail.pos.length = 0;
      // Dropping all but one point before the window bounds the trail.
      while (trail.at.length > 1 && trail.at[1] < from) {
        trail.at.shift();
        trail.pos.shift();
      }
      // Through the samples and on to the dot.
      if (machineLine && machine !== null && trail.at.length) {
        ctx.strokeStyle = machineColor;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        for (let i = 0; i < trail.at.length; i++) ctx.lineTo(x(trail.at[i]), y(trail.pos[i]));
        ctx.lineTo(px, y(machine));
        ctx.stroke();
      }

      if (machine !== null) {
        ctx.fillStyle = playheadColor;
        ctx.strokeStyle = lineColor;
        ctx.beginPath();
        ctx.arc(px, y(machine), lineWidth + 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      ossm?.removeEventListener("position", record);
    };
  }, [script, speed, playhead, reverse, appearance, width, videoRef, ossm, machineLine, overlaid, height, lineWidth, before, after]);

  /**
   * Drag the graph sideways to seek, as if grabbing the line; playback pauses
   * while dragging so the machine does not follow every seek.
   */
  const seek = (e: PointerEvent<HTMLCanvasElement>) => {
    const media = videoRef.current;
    if (!media) return;
    e.preventDefault();
    const target = e.currentTarget;
    const [startX, startTime, wasPlaying] = [e.clientX, playhead.current.get(), !media.paused];
    media.pause();
    const move = (m: globalThis.PointerEvent) =>
      playhead.current.set(startTime - ((m.clientX - startX) / width) * (before + after) * speed);
    target.setPointerCapture(e.pointerId);
    target.addEventListener("pointermove", move);
    target.addEventListener("lostpointercapture", () => {
      target.removeEventListener("pointermove", move);
      if (wasPlaying) void media.play();
    }, { once: true });
  };

  return (
    <Box position="relative" flexShrink="0" height={cssHeight === undefined ? "100%" : undefined}>
      <canvas
        ref={canvasRef}
        // Over the video, clicks go through to it or move the graph.
        onPointerDown={overlaid ? undefined : seek}
        style={{
          display: "block",
          cursor: overlaid ? undefined : "ew-resize",
          touchAction: "none",
          width: "100%",
          height: cssHeight ?? "100%",
          borderRadius: 6,
          background: overlay ? `rgba(0,0,0,${overlay.background / 100})` : "var(--gray-a2)",
        }}
      />
      {notice && (
        <Text
          size="1"
          color="amber"
          style={{ position: "absolute", top: 6, left: 8, padding: "2px 6px", borderRadius: 4, background: "var(--color-panel-solid)" }}
        >
          Machine not moving: {notice}
        </Text>
      )}
      {/* The graph shows stream positions: 100 (top) is the shallow end, out towards home. */}
      <Text size="1" color="gray" style={{ position: "absolute", top: 4, right: 8 }}>Out</Text>
      <Text size="1" color="gray" style={{ position: "absolute", bottom: 4, right: 8 }}>In</Text>
    </Box>
  );
}

/** Height of the minimap of the whole script below the graph, in px. */
const MINIMAP_HEIGHT = 40;

/**
 * The whole script with the graph's time and the playhead, as in the
 * editor's minimap. Dragging moves the graph's time and with it the
 * playhead; pressed outside the graph's time, it centres on the pointer
 * first. Playback pauses while dragging, as in the graph.
 */
function ScriptMinimap({ script, speed, playhead, reverse, videoRef, span: { before, after } }: {
  script: Funscript;
  speed: number;
  playhead: RefObject<Playhead>;
  reverse: boolean;
  videoRef: RefObject<HTMLMediaElement | null>;
  span: { before: number; after: number };
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const shownRef = useRef<SVGGElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(svgRef.current!);
    return () => observer.disconnect();
  }, []);

  const total = script.at[script.at.length - 1] || 1;
  const x = (at: number) => (at / total) * width;
  const points = useMemo(
    () => Array.from(script.at, (at, i) => `${(at / total) * width},${2 + (1 - (reverse ? 100 - script.pos[i] : script.pos[i]) / 100) * (MINIMAP_HEIGHT - 4)}`).join(" "),
    [script, reverse, total, width],
  );

  // The graph's time and the playhead follow the playhead every frame, without rendering.
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      shownRef.current?.setAttribute("transform", `translate(${(playhead.current.get() / total) * width},0)`);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [playhead, total, width]);

  const drag = (e: PointerEvent<SVGSVGElement>) => {
    const media = videoRef.current;
    if (e.button !== 0 || !media) return;
    e.preventDefault();
    const target = e.currentTarget;
    const left = target.getBoundingClientRect().left;
    const at = (m: { clientX: number }) => ((m.clientX - left) / width) * total;
    const now = playhead.current.get();
    const pressed = at(e);
    const grab = pressed >= now - before * speed && pressed <= now + after * speed ? pressed - now : ((after - before) * speed) / 2;
    const wasPlaying = !media.paused;
    media.pause();
    const move = (m: { clientX: number }) => playhead.current.set(at(m) - grab);
    move(e);
    target.setPointerCapture(e.pointerId);
    target.addEventListener("pointermove", move);
    target.addEventListener("lostpointercapture", () => {
      target.removeEventListener("pointermove", move);
      if (wasPlaying) void media.play();
    }, { once: true });
  };

  return (
    <svg
      ref={svgRef}
      height={MINIMAP_HEIGHT}
      aria-label="Minimap"
      onPointerDown={drag}
      style={{ display: "block", flexShrink: 0, width: "100%", borderRadius: 6, background: "var(--gray-a2)", touchAction: "none", userSelect: "none" }}
    >
      <polyline points={points} fill="none" stroke="#ec4899" strokeWidth={1} />
      <g ref={shownRef}>
        <rect
          x={-x(before * speed)}
          width={Math.max(x((before + after) * speed), 4)}
          height={MINIMAP_HEIGHT}
          rx={4}
          style={{ fill: "var(--gray-a5)", stroke: "var(--gray-a8)", cursor: "grab" }}
        />
        <line y1={0} y2={MINIMAP_HEIGHT} style={{ stroke: "var(--gray-12)" }} />
      </g>
    </svg>
  );
}
