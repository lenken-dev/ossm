import { useEffect, useMemo, useRef, useState, type CSSProperties, type MediaHTMLAttributes, type PointerEvent, type RefObject, type SyntheticEvent } from "react";
import { Box, Button, Callout, Dialog, Flex, IconButton, Popover, SegmentedControl, Select, Separator, Switch, Text } from "@radix-ui/themes";
import {
  CheckIcon,
  Cross2Icon,
  EnterFullScreenIcon,
  ExclamationTriangleIcon,
  ExitFullScreenIcon,
  GearIcon,
  HamburgerMenuIcon,
  HomeIcon,
  MoveIcon,
  StopIcon,
  UploadIcon,
} from "@radix-ui/react-icons";
import { bisectLeft } from "d3";
import { useAppearance } from "../hooks/useAppearance";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePersistedState } from "../hooks/usePersistedState";
import { log, useOssm, type Ossm, type OssmState, type PatternInfo } from "../player/ble";
import { FunscriptStream, simplify } from "../player/stream";
import { parseFunscript, type Funscript } from "../StreamPanel";
import { LabeledSlider } from "../TrajectoryPanel";
import { GraphLayout } from "./GraphPage";

type PlayerMode = "pattern" | "funscript";

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

/** Resize handles of the graph over the video, by the edges they move: corners and edges. */
const RESIZE_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const CORNER_HANDLE = 24;
const EDGE_HANDLE = 40;
/** Side length in px from which an edge handle fits between the corner handles. */
const EDGE_HANDLE_ROOM = 2 * CORNER_HANDLE + EDGE_HANDLE + 16;

/** Where a resize handle sits and how it looks: an L in a corner, a bar along an edge. */
function handleStyle(handle: string): CSSProperties {
  const border = "4px solid white";
  const corner = handle.length === 2;
  const across = 12;
  return {
    position: "absolute",
    width: corner ? CORNER_HANDLE : "ns".includes(handle) ? EDGE_HANDLE : across,
    height: corner ? CORNER_HANDLE : "ns".includes(handle) ? across : EDGE_HANDLE,
    borderRadius: corner ? 6 : undefined,
    cursor: `${handle}-resize`,
    filter: "drop-shadow(0 0 1px black) drop-shadow(0 0 2px black)",
    ...(handle.includes("n") ? { top: 0, borderTop: border } : handle.includes("s") ? { bottom: 0, borderBottom: border } : { top: `calc(50% - ${EDGE_HANDLE / 2}px)` }),
    ...(handle.includes("w") ? { left: 0, borderLeft: border } : handle.includes("e") ? { right: 0, borderRight: border } : { left: `calc(50% - ${EDGE_HANDLE / 2}px)` }),
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
  const [overlay, setOverlay] = usePersistedState("ossm:playerOverlay", DEFAULT_OVERLAY, localStorage);
  /** Height of the graph below the video, in px. */
  const [graphHeight, setGraphHeight] = usePersistedState("ossm:playerGraphHeight", PREVIEW_HEIGHT, localStorage);
  /** Time both graphs show before and after the video time, in ms. */
  const [graphWindow, setGraphWindow] = usePersistedState("ossm:playerGraphWindow", DEFAULT_WINDOW, localStorage);
  /** Moving and resizing the graph; otherwise clicks go through it to the video. */
  const [arranging, setArranging] = useState(false);
  /** The video area, which the graph's position and size are fractions of. */
  const stageRef = useRef<HTMLDivElement>(null);

  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!arranging || !stageRef.current) return;
    const observer = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [arranging, videoUrl]);

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
  /** Theater mode needs a video and a wide screen; closing the video leaves theater mode. */
  const inTheater = theater && !!videoUrl && !isMobile;
  /** The video, or the silent clock without one. */
  const videoRef = useRef<HTMLMediaElement>(null);
  const [paused, setPaused] = useState(true);
  const syncPaused = (e: { currentTarget: HTMLMediaElement }) => setPaused(e.currentTarget.paused);
  const [script, setScript] = useState<Funscript | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  // Only the latest picked script may replace the script or the error.
  const scriptGeneration = useRef(0);
  const [reverse, setReverse] = useState(false);
  const [simplified, setSimplified] = usePersistedState("ossm:playerSimplify", true, localStorage);
  /** The script as streamed and previewed. */
  const played = useMemo(() => script && simplified ? simplify(script) : script, [script, simplified]);
  /** Sync offset in ms; positive moves the machine earlier. Never sent to the device. */
  const [offset, setOffset] = usePersistedState("ossm:playerOffset", -50);
  const stream = useRef(new FunscriptStream());
  /** Depth and stroke set since connecting or entering funscript mode. */
  const [configured, setConfigured] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [speedLimit, setSpeedLimit] = usePersistedState("ossm:playerSpeedLimit", DEFAULT_SPEED_LIMIT, localStorage);
  const blocked = blockReason(ossm, state, configured, setupOpen);
  /** Set up to play; only speed and sensation may change on the fly. */
  const ready = !!ossm && ossm.lookahead > 0 && isHomed(state) && configured;

  /** Send `stream:end` if a stream is open. */
  const endStream = (reason: string) => {
    if (!stream.current.end()) return;
    const media = (videoRef.current?.currentTime ?? 0) * 1000 + offset;
    void ossm?.command("stream:end", `(${reason}, media=${Math.round(media)})`);
  };

  // Entering funscript mode (or connecting in it) sends `go:streaming`. A
  // stream left open in pattern mode is ended first, so the next one starts
  // fresh.
  useEffect(() => {
    if (mode !== "funscript" || !ossm || ossm.lookahead === 0) return;
    endStream("mode");
    void ossm.command("go:streaming");
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  useEffect(
    () =>
      ossm?.onDisconnect(() => {
        stream.current.end();
        videoRef.current?.pause();
      }),
    [ossm],
  );

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
      if (!video || video.seeking || video.readyState < video.HAVE_FUTURE_DATA || video.playbackRate <= 0) return;
      const media = video.currentTime * 1000 + offset;
      for (const p of stream.current.tick(played, media, video.playbackRate, reverse, ossm.lookahead)) {
        void ossm.streamPoint(p.position, p.duration);
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [mode, paused, blocked, ossm, played, offset, reverse]);

  // Video events that matter; in funscript mode all but `playing` end the stream.
  const videoEvent = (e: SyntheticEvent<HTMLMediaElement>) => {
    log(`video ${e.type}`);
    if (mode === "funscript" && e.type !== "playing") endStream(e.type);
  };

  useEffect(() => {
    setVideoUrl(null);
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  const silentMs = mode === "funscript" && !videoFile && script ? script.at[script.at.length - 1] : null;
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
    const generation = ++scriptGeneration.current;
    try {
      const parsed = parseFunscript(file.name, await file.text());
      if (generation !== scriptGeneration.current) return;
      endStream("script");
      setScript(parsed);
      setScriptError(null);
    } catch (e) {
      if (generation !== scriptGeneration.current) return;
      setScriptError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const lineWidthSlider = (
    <LabeledSlider
      label="Line width"
      value={overlay.lineWidth}
      display={`${overlay.lineWidth} px`}
      min={1}
      max={8}
      step={0.5}
      onChange={(lineWidth) => setOverlay({ ...overlay, lineWidth })}
    />
  );
  const windowSliders = (
    <>
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
    </>
  );

  /** Show and hide the controls pane, and the graph and its settings, in theater mode; in the pane while it is shown. */
  const theaterToggles = (style?: CSSProperties) => (
    <Flex gap="2" style={style}>
      <IconButton
        variant="surface"
        aria-label={showControls ? "Hide controls" : "Show controls"}
        onClick={() => setShowControls(!showControls)}
      >
        <HamburgerMenuIcon />
      </IconButton>
      {mode === "funscript" && played && (
        <Popover.Root>
          <Popover.Trigger>
            <IconButton variant="surface" aria-label="Settings">
              <GearIcon />
            </IconButton>
          </Popover.Trigger>
          <Popover.Content width="260px">
            <Flex direction="column" gap="3">
              <Text as="label" size="2" weight="medium">
                <Flex align="center" justify="between" gap="2">
                  Show graph
                  <Switch checked={showGraph} onCheckedChange={setShowGraph} />
                </Flex>
              </Text>
              {showGraph && (
                <>
                  <Separator size="4" />
                  {lineWidthSlider}
                  {windowSliders}
                  <LabeledSlider
                    label="Background"
                    value={overlay.background}
                    display={`${overlay.background}%`}
                    min={0}
                    max={100}
                    step={5}
                    onChange={(background) => setOverlay({ ...overlay, background })}
                  />
                  <Popover.Close>
                    <Button variant="soft" onClick={() => setArranging(true)}>
                      <MoveIcon /> Move and resize
                    </Button>
                  </Popover.Close>
                  <Button
                    variant="soft"
                    color="gray"
                    onClick={() => {
                      setOverlay(DEFAULT_OVERLAY);
                      setGraphWindow(DEFAULT_WINDOW);
                    }}
                  >
                    Reset
                  </Button>
                </>
              )}
            </Flex>
          </Popover.Content>
        </Popover.Root>
      )}
    </Flex>
  );

  const sidebar = (
    <>
      {inTheater && theaterToggles({ padding: "var(--space-3)", paddingBottom: 0 })}
      <Box p="3" pb="0">
        <SegmentedControl.Root
          value={mode}
          onValueChange={(v) => {
            log(`mode ${v}`);
            dropSilence("mode");
            setMode(v as PlayerMode);
          }}
          style={{ width: "100%" }}
        >
          <SegmentedControl.Item value="pattern">Pattern</SegmentedControl.Item>
          <SegmentedControl.Item value="funscript">Funscript</SegmentedControl.Item>
        </SegmentedControl.Root>
      </Box>
      <Flex direction="column" gap="3" p="3">
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
            {(mode === "pattern" || !isHomed(state)) && (
              <Button
                variant={mode === "pattern" ? "soft" : "solid"}
                loading={state?.state === "homing"}
                disabled={mode === "pattern" && !paused}
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
        {mode === "pattern" && ossm && state && (
          <>
            <Separator size="4" />
            <PatternControls ossm={ossm} state={state} endStream={endStream} />
          </>
        )}
        {mode === "funscript" && (
          <>
            <Separator size="4" />
            {ossm && ossm.lookahead === 0 ? (
              <Text size="2" color="gray">This firmware cannot stream.</Text>
            ) : ossm && state && isHomed(state) && (
              !configured ? (
                <Button onClick={openSetup}>Set depth and stroke</Button>
              ) : <>
                <SettingSlider ossm={ossm} setting="speed" label="Speed" value={state.speed} />
                <SettingSlider ossm={ossm} setting="sensation" label="Sensation" value={state.sensation} ends={["Smooth", "Hard"]} />
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
                onDone={() => setConfigured(true)}
                onClose={() => setSetupOpen(false)}
              />
            )}
            {ready && (
              <LabeledSlider
                label="Sync offset"
                value={offset}
                display={`${offset > 0 ? "+" : ""}${offset} ms`}
                min={-500}
                max={500}
                step={5}
                disabled={!paused}
                onChange={setOffset}
              />
            )}
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
          </>
        )}
      </Flex>
    </>
  );

  const mediaProps = {
    ref: (el: HTMLMediaElement | null) => void (videoRef.current = el),
    controls: true,
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
    onWaiting: videoEvent,
    onRateChange: videoEvent,
    onEnded: videoEvent,
  } satisfies MediaHTMLAttributes<HTMLMediaElement> & { ref: unknown };

  const content = (
    <Flex direction="column" gap="3" p={inTheater ? "0" : "3"} height="100%">
      <input
        ref={videoInput}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            dropSilence("video");
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
              {!isMobile && (
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
          {/* The video stays at this place in the tree, so toggling theater mode does not reload it. */}
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
                <ScriptPreview script={played} reverse={reverse} videoRef={videoRef} notice={blocked} lineWidth={overlay.lineWidth} span={graphWindow} overlay={overlay} />
                {arranging &&
                  RESIZE_HANDLES.filter(
                    (h) => h.length === 2 || ("ns".includes(h) ? overlay.width * stageSize.width : overlay.height * stageSize.height) >= EDGE_HANDLE_ROOM,
                  ).map((h) => (
                    <Box key={h} title="Drag to resize" style={handleStyle(h)} onPointerDown={(e) => dragOverlay(e, h)} />
                  ))}
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
        </>
      ) : (
        <Flex direction="column" align="center" justify="center" gap="3" flexGrow="1">
          <Text size="2" color="gray">
            {mode === "funscript" ? "Open a video to play it with the funscript." : "Open a video to play it here."}
          </Text>
          <Button variant="soft" onClick={() => videoInput.current?.click()}>
            <UploadIcon /> Open video
          </Button>
        </Flex>
      )}
      {silentUrl && <audio {...mediaProps} src={silentUrl} style={{ width: "100%", flexShrink: 0 }} />}
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
                <Popover.Root>
                  <Popover.Trigger>
                    <IconButton variant="soft" color="gray" aria-label="Graph settings">
                      <GearIcon />
                    </IconButton>
                  </Popover.Trigger>
                  <Popover.Content width="260px">
                    <Flex direction="column" gap="3">
                      {lineWidthSlider}
                      {windowSliders}
                      <Text size="1" color="gray">Drag the top edge of the graph to change its height.</Text>
                      <Button
                        variant="soft"
                        color="gray"
                        onClick={() => {
                          setOverlay({ ...overlay, lineWidth: DEFAULT_OVERLAY.lineWidth });
                          setGraphHeight(PREVIEW_HEIGHT);
                          setGraphWindow(DEFAULT_WINDOW);
                        }}
                      >
                        Reset
                      </Button>
                    </Flex>
                  </Popover.Content>
                </Popover.Root>
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
              <ScriptPreview script={played} reverse={reverse} videoRef={videoRef} notice={blocked} lineWidth={overlay.lineWidth} span={graphWindow} height={graphHeight} />
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
function PatternControls({ ossm, state, endStream }: {
  ossm: Ossm;
  state: OssmState;
  /** Ends a stream left open by funscript mode before a pattern command. */
  endStream: (reason: string) => void;
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

  return (
    <>
      <Box>
        <Text size="2" weight="medium" mb="1" as="div">Pattern</Text>
        <Select.Root
          value={selected == null ? "" : String(selected)}
          onValueChange={(v) => {
            endStream("pattern");
            void ossm.command(`set:pattern:${v}`);
          }}
        >
          <Select.Trigger placeholder="Choose a pattern" style={{ width: "100%" }} />
          <Select.Content>
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
        color="red"
        size="3"
        style={{ height: 64 }}
        onClick={() => {
          endStream("stop");
          void ossm.command("go:menu");
        }}
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
        <Dialog.Content maxWidth="360px">
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
function SetupDialog({ ossm, state, speedLimit, setSpeedLimit, onDone, onClose }: {
  ossm: Ossm;
  state: OssmState;
  speedLimit: number;
  setSpeedLimit: (limit: number) => void;
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
  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Content maxWidth="420px">
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
        <Flex justify="end" gap="2" mt="4">
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

/**
 * The script's raw points around the video time, redrawn every animation
 * frame. Works without a video (time 0). `notice` says why the machine does
 * not follow.
 */
function ScriptPreview({ script, reverse, videoRef, notice, lineWidth, span: { before, after }, height: cssHeight, overlay }: {
  script: Funscript;
  reverse: boolean;
  videoRef: RefObject<HTMLMediaElement | null>;
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
    const pad = 6;
    const y = (pos: number) => pad + (1 - (reverse ? 100 - pos : pos) / 100) * (height - 2 * pad);

    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const now = (videoRef.current?.currentTime ?? 0) * 1000;
      const from = now - before;
      const to = now + after;
      const x = (at: number) => ((at - from) / (to - from)) * width;
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
      const first = Math.max(bisectLeft(script.at, from) - 1, 0);
      let last = first;
      while (last < script.at.length - 1 && script.at[last] <= to) last++;
      ctx.strokeStyle = lineColor;
      ctx.fillStyle = lineColor;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = first; i <= last; i++) ctx.lineTo(x(script.at[i]), y(script.pos[i]));
      ctx.stroke();
      for (let i = first; i <= last; i++) {
        ctx.beginPath();
        ctx.arc(x(script.at[i]), y(script.pos[i]), lineWidth + 1, 0, Math.PI * 2);
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
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [script, reverse, appearance, width, videoRef, overlaid, height, lineWidth, before, after]);

  return (
    <Box position="relative" flexShrink="0" height={cssHeight === undefined ? "100%" : undefined}>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
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
