import { useEffect, useMemo, useRef, useState, type CSSProperties, type MediaHTMLAttributes, type PointerEvent, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Box, Button, Callout, DataList, Flex, Heading, IconButton, SegmentedControl, Separator, Switch, Text, TextField, Theme, Tooltip } from "@radix-ui/themes";
import {
  CheckIcon,
  Cross2Icon,
  EnterFullScreenIcon,
  ExclamationTriangleIcon,
  ExitFullScreenIcon,
  HamburgerMenuIcon,
  HomeIcon,
  MoveIcon,
  OpenInNewWindowIcon,
  PauseIcon,
  PlayIcon,
  StopIcon,
  UploadIcon,
} from "@radix-ui/react-icons";
import { useAppearance } from "../hooks/useAppearance";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePersistedState } from "../hooks/usePersistedState";
import { log, useOssm } from "../player/ble";
import { FunscriptStream, simplify } from "../player/stream";
import { formatScriptTime, parseFunscript, readFunscript, PLAYER_WINDOW, SENT_SCRIPT_KEY, type Funscript } from "../StreamPanel";
import { FIRMWARE_RANGE_MM, RANGE_KEY, useFollow } from "../hooks/useFollow";
import { LabeledSlider } from "../TrajectoryPanel";
import { GraphLayout } from "./GraphPage";
import { stats, type Action } from "../funscript/model";
import { markerColor, readMarkers } from "../funscript/markers";
import { SectionHeader, Stats } from "../funscript/widgets";
import { DEPTH_ENDS, PatternControls, PortalContainer, SettingSlider, SetupDialog, STROKE_ENDS } from "../player/controls";
import { ScriptMinimap } from "../player/ScriptMinimap";
import { ScriptPreview } from "../player/ScriptPreview";
import { advancing, blockReason, DEFAULT_SPEED_LIMIT, isHomed, silence, TICK_MS, type Markers, type Playhead } from "../player/playback";
import { DEFAULT_OVERLAY, dragAxis, handleStyle, OVERLAY_MIN_HEIGHT, OVERLAY_MIN_WIDTH, RESIZE_HANDLES } from "../player/overlay";

type PlayerMode = "pattern" | "funscript";

const NO_MARKERS: Markers = { chapters: [], bookmarks: [] };
/** The markers in the .funscript `text` that parsed to `script`. */
const markersOf = (text: string, script: Funscript): Markers => readMarkers(JSON.parse(text) as Record<string, unknown>, script.at[script.at.length - 1]);

/** Size the popout window opens at, in px. */
const POPOUT_SIZE = { width: 320, height: 640 };

/** Default and smallest height of the preview graph below the video, in px. */
const PREVIEW_HEIGHT = 140;
const PREVIEW_MIN_HEIGHT = 60;
/** Default time the preview graphs show before and after the video time, in ms. */
const DEFAULT_WINDOW = { before: 2000, after: 8000 };
/** Choices for the time after the video time, in s: by the second up to 30 s, then by 10 s. */
const AFTER_STOPS = [...Array.from({ length: 30 }, (_, i) => i + 1), 40, 50, 60, 70, 80, 90, 100, 110, 120];

export default function PlayerPage() {
  const [mode, setMode] = usePersistedState<PlayerMode>("ossm:playerMode", "pattern");
  const { ossm, state, connecting, error, connect, disconnect } = useOssm();
  const videoInput = useRef<HTMLInputElement>(null);
  const scriptInput = useRef<HTMLInputElement>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [silentUrl, setSilentUrl] = useState<string | null>(null);
  const [theater, setTheater] = useState(false);
  const [showGraph, setShowGraph] = usePersistedState("ossm:playerGraph", true, localStorage);
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
  const [markers, setMarkers] = useState(NO_MARKERS);
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
  const [offset, setOffset] = usePersistedState("ossm:playerOffset", 50);
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
  /** Depth and stroke sliders in the controls, changed while playing. */
  const [depthSliders, setDepthSliders] = usePersistedState("ossm:playerDepthSliders", false, localStorage);
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

  /** Switch to mode `v`; callers check `switchLock`. */
  const switchMode = (v: PlayerMode) => {
    log(`mode ${v}`);
    dropSilence("mode");
    // Leaving funscript mode leaves streaming (any remote's), so patterns can play;
    // the switch is locked while the stream runs, so none of ours is open.
    if (v === "pattern" && state?.state === "streaming") void ossm?.command("go:menu");
    setMode(v);
  };

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
      setMarkers(markersOf(await file.text(), parsed));
      setScriptError(null);
    } catch (e) {
      setScriptError((e as Error).message);
    }
  };

  /** Load a script the editor sent, `raw` from `SENT_SCRIPT_KEY`, in funscript mode unless a pattern plays. */
  const loadSent = (raw: string | null) => {
    if (!raw) return;
    try {
      const parsed = parseFunscript((JSON.parse(raw) as { name: string }).name, raw);
      endStream("script");
      setScript(parsed);
      setMarkers(markersOf(raw, parsed));
      setScriptError(null);
      if (mode === "pattern" && !switchLock) switchMode("funscript");
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
    window.name = PLAYER_WINDOW;
    return () => void (window.name = "");
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
  const [statsOpen, setStatsOpen] = useState(false);
  const [markersOpen, setMarkersOpen] = useState(false);
  /** The index of the chapter the playhead is in, or -1; followed only while the Markers list shows. */
  const [chapterAt, setChapterAt] = useState(-1);
  useEffect(() => {
    if (!markersOpen || !markers.chapters.length) return;
    const id = setInterval(() => {
      const t = playhead.current.get();
      setChapterAt(markers.chapters.findIndex((c) => c.start <= t && t < c.end));
    }, 250);
    return () => clearInterval(id);
  }, [markersOpen, markers]);
  /** The played script's points, for its stats. */
  const playedActions = useMemo<Action[]>(() => played ? Array.from(played.at, (at, i) => ({ at, pos: played.pos[i] })) : [], [played]);
  const playedAverage = useMemo(() => playedActions.length && stats(playedActions, [...playedActions.keys()]).average, [playedActions]);
  const [calcOpen, setCalcOpen] = useState(false);
  /** The calculator's machine range, in mm, shared with the editor's. */
  const [savedRangeMm, setRangeMm] = usePersistedState(RANGE_KEY, FIRMWARE_RANGE_MM, localStorage);
  /** The connected machine's travel, or until known the range typed in. */
  const machineRangeMm = ossm?.travelMm ?? null;
  const rangeMm = machineRangeMm ?? savedRangeMm;
  // Saved for the editor's calculator too.
  useEffect(() => {
    if (machineRangeMm !== null) setRangeMm(machineRangeMm);
  }, [machineRangeMm, setRangeMm]);
  /** The machine's settings, 0–100, or until connected full depth and stroke at the middle sensation. */
  const calcSettings = { depth: state?.depth ?? 100, stroke: state?.stroke ?? 100, sensation: state?.sensation ?? 50, speed: state?.speed ?? 0 };
  /** The speed the script needs, and the share of its points reached at the machine's speed. */
  const calc = useFollow(useMemo(() => {
    if (!calcOpen || !played) return null;
    const { depth, stroke, sensation, speed } = calcSettings;
    return { kind: "script" as const, script: played, rate: scriptSpeed, settings: { rangeMm, depth: depth / 100, stroke: stroke / 100, jerk: sensation / 100 }, speed: speed / 100 };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- its values, not the object made each render
  }, [calcOpen, played, scriptSpeed, rangeMm, calcSettings.depth, calcSettings.stroke, calcSettings.sensation, calcSettings.speed]));
  const needed = calc?.needed;
  const media = videoUrl || silentUrl;
  const controls = (inPopout: boolean) => (
    <>
      <Flex p="3" pb="0" gap="2">
        <Tooltip content={switchLock} open={switchLock ? undefined : false} container={inPopout ? popout?.document.body : undefined}>
          <Box flexGrow="1">
            <SegmentedControl.Root
              value={mode}
              disabled={!!switchLock}
              onValueChange={(v) => switchMode(v as PlayerMode)}
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
            {ossm.canHome && !isHomed(state) && !(mode === "pattern" && patternActive) && (
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
        {mode === "pattern" && ossm && state && (isHomed(state) || patternActive || (!ossm.canHome && state.state !== "homing")) && (
          <>
            <Separator size="4" />
            <PatternControls ossm={ossm} state={state} />
          </>
        )}
        {mode === "funscript" && (
          <>
            {ossm && ossm.lookahead === 0 ? (
              <Callout.Root color="red" size="1">
                <Callout.Icon>
                  <ExclamationTriangleIcon />
                </Callout.Icon>
                <Callout.Text>This firmware cannot stream.</Callout.Text>
              </Callout.Root>
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
            <SectionHeader title="Funscript" open={funscriptOpen} setOpen={setFunscriptOpen} />
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
            {/* The script's chapters and bookmarks in time; a click plays from there. */}
            {played && (markers.chapters.length > 0 || markers.bookmarks.length > 0) && <>
              <SectionHeader title="Markers" open={markersOpen} setOpen={setMarkersOpen} summary={`${markers.chapters.length + markers.bookmarks.length}`} />
              {markersOpen && (
                <Flex direction="column">
                  {[...markers.chapters.map((c, k) => ({ name: c.name, at: c.start, end: c.end, k })), ...markers.bookmarks.map((b) => ({ name: b.name, at: b.time, end: null, k: -1 }))]
                    .sort((a, b) => a.at - b.at)
                    .map(({ name, at, end, k }, i) => (
                      <Flex
                        key={i}
                        align="center"
                        gap="2"
                        px="1"
                        role="button"
                        onClick={() => playhead.current.set(at)}
                        style={{ minHeight: 28, borderRadius: 4, cursor: "pointer", userSelect: "none", background: k >= 0 && k === chapterAt ? "var(--accent-a4)" : undefined }}
                      >
                        {/* A bookmark's colour, as in the editor. */}
                        {end === null && <Box flexShrink="0" width="8px" height="8px" style={{ borderRadius: "50%", background: `var(--${markerColor(name)}-9)` }} />}
                        <Text size="2" truncate style={{ flexGrow: 1 }}>{name}</Text>
                        <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                          {formatScriptTime(at / 1000)}{end !== null && `–${formatScriptTime(end / 1000)}`}
                        </Text>
                      </Flex>
                    ))}
                </Flex>
              )}
              <Separator size="4" />
            </>}
            {/* The played script's stats; collapsed, its average speed. */}
            {played && <>
              <SectionHeader title="Stats" open={statsOpen} setOpen={setStatsOpen} summary={!!playedAverage && `${Math.round(playedAverage)}/s avg`} />
              {statsOpen && <Stats actions={playedActions} picked={[...playedActions.keys()]} size="2" />}
              <Separator size="4" />
            </>}
            <SectionHeader title="Speed Calculator" open={calcOpen} setOpen={setCalcOpen} />
            {calcOpen && <>
              {/* Typing keeps the last range from 10 mm on. The connected machine's travel replaces it. */}
              <TextField.Root key={machineRangeMm} type="number" min={10} step="any" aria-label="Machine range" defaultValue={rangeMm} disabled={machineRangeMm !== null} onChange={(e) => Number(e.target.value) >= 10 && setRangeMm(Number(e.target.value))}>
                <TextField.Slot side="left">Machine range</TextField.Slot>
                <TextField.Slot side="right">mm</TextField.Slot>
              </TextField.Root>
              {!played ? (
                <Text size="2" color="gray">Load a script to see the speed it needs.</Text>
              ) : <>
                <DataList.Root size="2">
                  <Tooltip
                    container={inPopout ? popout?.document.body : undefined}
                    content={`The lowest speed at which the machine reaches 95% of the script's points on time, at depth ${calcSettings.depth.toFixed(0)}%, stroke ${calcSettings.stroke.toFixed(0)}% and sensation ${calcSettings.sensation.toFixed(0)}%${scriptSpeed !== 1 ? ` played x${scriptSpeed}` : ""}.${needed === null ? " Raise the sensation or shorten the stroke." : ""}`}
                  >
                    <DataList.Item>
                      <DataList.Label color="gray">Speed needed</DataList.Label>
                      <DataList.Value>{needed === undefined ? "…" : needed === null ? "Over 100%" : `${needed}%`}</DataList.Value>
                    </DataList.Item>
                  </Tooltip>
                  {/* Only the connected machine has a speed. */}
                  {state && calc && (
                    <DataList.Item>
                      <DataList.Label color="gray">Points reached</DataList.Label>
                      <DataList.Value>{(calc.reached * 100).toFixed(1)}%</DataList.Value>
                    </DataList.Item>
                  )}
                </DataList.Root>
              </>}
            </>}
            <Separator size="4" />
            <SectionHeader title="Graph" open={graphOpen} setOpen={setGraphOpen} />
            {graphOpen && <>
              <Text as="label" size="2" weight="medium">
                <Flex align="center" justify="between" gap="2">
                  Show graph
                  <Switch checked={showGraph} onCheckedChange={setShowGraph} />
                </Flex>
              </Text>
              <Text as="label" size="2" weight="medium">
                <Flex align="center" justify="between" gap="2">
                  Show minimap
                  <Switch checked={inTheater ? theaterMinimap : minimap} onCheckedChange={inTheater ? setTheaterMinimap : setMinimap} />
                </Flex>
              </Text>
              {showGraph && (
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
                  <ScriptPreview script={played} chapters={markers.chapters} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} ossm={ossm} machineLine={machineLine} notice={blocked} lineWidth={overlay.lineWidth} span={graphWindow} overlay={overlay} />
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
            <ScriptMinimap script={played} markers={markers} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} span={graphWindow} />
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
                    setMarkers(NO_MARKERS);
                    setScriptError(null);
                  }}
                >
                  <Cross2Icon /> Close
                </Button>
              </Flex>
            </Flex>
            {showGraph && <Box position="relative" flexShrink="0">
              <ScriptPreview script={played} chapters={markers.chapters} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} ossm={ossm} machineLine={machineLine} notice={blocked} lineWidth={overlay.lineWidth} span={graphWindow} height={graphHeight} />
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
            </Box>}
            {minimap && <ScriptMinimap script={played} markers={markers} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} span={graphWindow} />}
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
