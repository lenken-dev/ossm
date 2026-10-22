import { useEffect, useMemo, useRef, useState, type CSSProperties, type MediaHTMLAttributes, type RefObject, type SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Box, Button, Callout, Flex, Heading, IconButton, SegmentedControl, Separator, Text, Theme, Tooltip } from "@radix-ui/themes";
import {
  Cross2Icon,
  EnterFullScreenIcon,
  ExclamationTriangleIcon,
  ExitFullScreenIcon,
  HamburgerMenuIcon,
  HomeIcon,
  OpenInNewWindowIcon,
  PauseIcon,
  PlayIcon,
  UploadIcon,
} from "@radix-ui/react-icons";
import { useAppearance } from "../hooks/useAppearance";
import { useIsMobile } from "../hooks/useIsMobile";
import { useMediaFile } from "../hooks/useMediaFile";
import { usePersistedState } from "../hooks/usePersistedState";
import { log, useOssm } from "../player/ble";
import { simplify } from "../player/stream";
import { parseFunscript, readFunscript, PLAYER_WINDOW, SENT_SCRIPT_KEY, type Funscript } from "../funscript/file";
import { DEPTH_ENDS, LabeledSlider, ResizeGrip, SENSATION_ENDS, STROKE_ENDS } from "../widgets";
import { GraphLayout } from "./GraphPage";
import { stats, type Action } from "../funscript/model";
import { readMarkers, type Bookmark, type Chapter } from "../funscript/markers";
import { MarkersList } from "../funscript/MarkersList";
import { Minimap } from "../funscript/Minimap";
import { PortalContainer, SectionHeader, Stats } from "../funscript/widgets";
import { SpeedCalculator } from "../funscript/SpeedCalculator";
import { MACHINE_DEFAULTS, PatternControls, SettingSlider, SetupDialog, StopButton, type MachinePrefs } from "../player/controls";
import { GRAPH_DEFAULTS, GraphSettings, type GraphPrefs } from "../player/GraphSettings";
import { ScriptPreview } from "../player/ScriptPreview";
import { ScriptSettings, type PlaybackPrefs } from "../player/ScriptSettings";
import { TheaterGraph } from "../player/TheaterGraph";
import { usePlayhead } from "../player/usePlayhead";
import { isHomed, isPatternActive, type Markers, type Playhead } from "../player/playback";
import { useArrangement } from "../player/useArrangement";
import { useScriptStream } from "../player/useScriptStream";
import { useSilentClock } from "../player/useSilentClock";

type PlayerMode = "pattern" | "funscript";
/** The collapsible sections of the controls. */
type Section = "funscript" | "markers" | "stats" | "calc" | "graph";

const NO_MARKERS: Markers = { chapters: [], bookmarks: [] };
/** The markers in the .funscript `text` that parsed to `script`. */
const markersOf = (text: string, script: Funscript): Markers => readMarkers(JSON.parse(text) as Record<string, unknown>, script.at[script.at.length - 1]);

/**
 * The minimap with the graph's time, `before` and `after` the playhead at
 * `speed`; dragging it moves the playhead. It renders on its own every frame
 * to follow the playhead, without the page.
 */
function PlayerMinimap({ actions, markers, speed, playhead, reverse, videoRef, span: { before, after } }: {
  actions: Action[];
  markers: Markers;
  speed: number;
  playhead: RefObject<Playhead>;
  reverse: boolean;
  videoRef: RefObject<HTMLMediaElement | null>;
  span: { before: number; after: number };
}) {
  const [now, setNow] = useState(() => playhead.current.get());
  useEffect(() => {
    let frame = requestAnimationFrame(function tick() {
      setNow(playhead.current.get());
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [playhead]);
  return (
    <Minimap
      actions={actions}
      total={actions[actions.length - 1]?.at || 1}
      chapters={markers.chapters}
      bookmarks={markers.bookmarks}
      window={{ from: now - before * speed, span: (before + after) * speed }}
      onDrag={(from) => playhead.current.set(from + before * speed)}
      playheadAt={now}
      media={videoRef}
      reverse={reverse}
    />
  );
}

export default function PlayerPage() {
  const [mode, setMode] = usePersistedState<PlayerMode>("ossm:playerMode", "pattern");
  const { ossm, state, connecting, error, connect, disconnect } = useOssm();
  const scriptInput = useRef<HTMLInputElement>(null);
  const { file: videoFile, url: videoUrl, isAudio, choose: chooseVideo, close: closeVideo, input: videoInput } = useMediaFile((file) => {
    if (file) {
      silent.drop("video");
      // Switching between video and audio swaps the element, whose events then never reach React.
      endStream("video");
    } else {
      // The video unmounts, so its pause and emptied events never reach React.
      endStream("close");
    }
    setPaused(true);
  });
  const isMobile = useIsMobile();
  const [appearance] = useAppearance();
  const [graph, setGraph] = usePersistedState<GraphPrefs>("ossm:playerGraphPrefs", GRAPH_DEFAULTS, localStorage);
  const { inTheater, enterTheater, leaveTheater, showControls, toggleControls, popout, openPopout, arranging, arrange, doneArranging, stageRef, dragGraphHeight } = useArrangement({
    canTheater: !!videoUrl && !isAudio && !isMobile,
    height: graph.height,
    onHeight: (height) => setGraph((g) => ({ ...g, height })),
  });
  /** The video, or the silent clock without one. */
  const videoRef = useRef<HTMLMediaElement>(null);
  const [paused, setPaused] = useState(true);
  const syncPaused = (e: { currentTarget: HTMLMediaElement }) => setPaused(e.currentTarget.paused);
  const [script, setScript] = useState<Funscript | null>(null);
  const [markers, setMarkers] = useState(NO_MARKERS);
  const [scriptError, setScriptError] = useState<string | null>(null);
  /** The playback prefs by how long they are kept: across sessions, for the tab's session, not at all. */
  const [kept, setKept] = usePersistedState("ossm:playerPlayback", { simplified: true, looped: false }, localStorage);
  const [session, setSession] = usePersistedState("ossm:playerPlaybackSession", { speed: 1, synced: true });
  const [reverse, setReverse] = useState(false);
  const playback: PlaybackPrefs = { ...kept, ...session, reverse };
  const { speed: scriptSpeed, simplified, synced, looped } = playback;
  /** The script as streamed and previewed. */
  const played = useMemo(() => script && simplified ? simplify(script) : script, [script, simplified]);
  /** Sync offset in ms; positive moves the machine earlier. Never sent to the device. */
  const [offset, setOffset] = usePersistedState("ossm:playerOffset", 50);
  /** The offset slider's value while dragged; the offset applies on release. */
  const [offsetDraft, setOffsetDraft] = useState<number | null>(null);
  const { playhead, retimeClock, stopClockAt } = usePlayhead({ videoRef, synced, scriptSpeed, scriptEnd: played ? played.at[played.at.length - 1] : 0 });
  const [machine, setMachine] = usePersistedState<MachinePrefs>("ossm:playerMachine", MACHINE_DEFAULTS, localStorage);
  const { configured, setupOpen, blocked, endStream, openSetup, closeSetup, setUp } = useScriptStream({
    active: mode === "funscript",
    ossm,
    state,
    videoRef,
    paused,
    script: played,
    playhead,
    offset,
    speed: scriptSpeed,
    reverse,
    speedLimit: machine.speedLimit,
  });
  const silent = useSilentClock({
    ms: mode === "funscript" && !videoFile && script ? script.at[script.at.length - 1] / scriptSpeed : null,
    speed: scriptSpeed,
    videoRef,
    onDrop: (reason) => {
      endStream(reason);
      setPaused(true);
    },
  });
  /**
   * Why the mode cannot change while it plays, or `null` when it can; the
   * device refuses the switch too. A video the machine does not follow does
   * not lock it.
   */
  const patternActive = isPatternActive(state);
  const switchLock = mode === "pattern"
    ? patternActive && "Stop the pattern to switch modes"
    : !paused && !blocked && "Pause playback to switch modes";
  /** Set up to play; only speed and sensation may change on the fly. */
  const ready = !!ossm && ossm.lookahead > 0 && isHomed(state) && configured;

  /** Switch to mode `v`; callers check `switchLock`. */
  const switchMode = (v: PlayerMode) => {
    log(`mode ${v}`);
    silent.drop("mode");
    // Leaving funscript mode leaves streaming (any remote's), so patterns can play;
    // the switch is locked while the stream runs, so none of ours is open.
    if (v === "pattern" && state?.state === "streaming") void ossm?.command("go:menu");
    setMode(v);
  };

  // Video events that matter; in funscript mode all but `playing` end the stream.
  const videoEvent = (e: SyntheticEvent<HTMLMediaElement>) => {
    log(`video ${e.type}`);
    retimeClock();
    if (mode === "funscript" && e.type !== "playing") endStream(e.type);
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
        onClick={toggleControls}
      >
        <HamburgerMenuIcon />
      </IconButton>
    </Flex>
  );

  /** The sections of the controls that are expanded; the rest show only their titles. */
  const [open, setOpen] = useState(new Set<Section>());
  /** Whether section `name` is expanded, and expanding and collapsing it. */
  const section = (name: Section) => ({
    open: open.has(name),
    setOpen: (on: boolean) => setOpen((o) => new Set(on ? [...o, name] : [...o].filter((s) => s !== name))),
  });
  const markersOpen = open.has("markers");
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
  const media = videoUrl || silent.url;
  const playButton = media && (
    <Button variant="soft" onClick={() => (paused ? void videoRef.current?.play() : videoRef.current?.pause())}>
      {paused ? <><PlayIcon /> Play</> : <><PauseIcon /> Pause</>}
    </Button>
  );
  /** In the popout window while it is open, else in the sidebar. */
  const controls = (
    <>
      <Flex p="3" pb="0" gap="2">
        <Tooltip content={switchLock} open={switchLock ? undefined : false} container={popout?.document.body}>
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
        {!popout && window.documentPictureInPicture && !isMobile && (
          <IconButton variant="soft" color="gray" aria-label="Pop out controls" title="Pop out controls" onClick={() => void openPopout()}>
            <OpenInNewWindowIcon />
          </IconButton>
        )}
      </Flex>
      <Flex direction="column" gap="3" p="3">
        {popout && playButton}
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
                <SettingSlider ossm={ossm} setting="sensation" label="Sensation" value={state.sensation} ends={SENSATION_ENDS} />
                {machine.depthSliders && <>
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
                prefs={machine}
                onChange={setMachine}
                onDone={setUp}
                onClose={closeSetup}
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
            {ready && playButton}
            {ready && (
              <StopButton
                onClick={() => {
                  videoRef.current?.pause();
                  endStream("stop");
                  void ossm.command("go:menu");
                }}
              />
            )}
            <Separator size="4" />
            <SectionHeader title="Funscript" {...section("funscript")} />
            {open.has("funscript") && (
              <ScriptSettings
                paused={paused}
                prefs={playback}
                onChange={(next) => {
                  // The silent clock's length follows the speed; keep the playhead at the same script time.
                  if (next.speed !== scriptSpeed) silent.hold();
                  // The script's own playhead starts where the media's left it.
                  if (synced && !next.synced) stopClockAt(playhead.current.get());
                  setKept({ simplified: next.simplified, looped: next.looped });
                  setSession({ speed: next.speed, synced: next.synced });
                  setReverse(next.reverse);
                }}
              />
            )}
            <Separator size="4" />
            {/* The script's chapters and bookmarks in time; a click plays from there. */}
            {played && (markers.chapters.length > 0 || markers.bookmarks.length > 0) && <>
              <SectionHeader title="Markers" {...section("markers")} summary={`${markers.chapters.length + markers.bookmarks.length}`} />
              {markersOpen && (
                <MarkersList
                  chapters={markers.chapters}
                  bookmarks={markers.bookmarks}
                  highlighted={(m) => m === markers.chapters[chapterAt]}
                  onClick={(m) => playhead.current.set("start" in m ? (m as Chapter).start : (m as Bookmark).time)}
                />
              )}
              <Separator size="4" />
            </>}
            {/* The played script's stats; collapsed, its average speed. */}
            {played && <>
              <SectionHeader title="Stats" {...section("stats")} summary={!!playedAverage && `${Math.round(playedAverage)}/s avg`} />
              {open.has("stats") && <Stats actions={playedActions} picked={[...playedActions.keys()]} size="2" />}
              <Separator size="4" />
            </>}
            <SpeedCalculator {...section("calc")} script={played} rate={scriptSpeed} machine={state} machineRangeMm={ossm?.travelMm ?? null} />
            <Separator size="4" />
            <SectionHeader title="Graph" {...section("graph")} />
            {open.has("graph") && <GraphSettings prefs={graph} onChange={setGraph} theater={inTheater} canArrange={!!played} onArrange={arrange} />}
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
              <PortalContainer.Provider value={popout.document.body}>{controls}</PortalContainer.Provider>
            </Theme>,
            popout.document.body,
          )}
        </Flex>
      ) : controls}
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
      {videoInput}
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
                <Button variant="soft" onClick={enterTheater}>
                  <EnterFullScreenIcon /> Theater
                </Button>
              )}
              <Button variant="soft" onClick={chooseVideo}>
                <UploadIcon /> Change media
              </Button>
              <Button variant="soft" color="gray" onClick={closeVideo}>
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
              {inTheater && mode === "funscript" && played && graph.shown && (
                <TheaterGraph stage={stageRef} overlay={graph.overlay} setOverlay={(overlay) => setGraph((g) => ({ ...g, overlay }))} arranging={arranging} onDone={doneArranging}>
                  <ScriptPreview script={played} chapters={markers.chapters} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} ossm={ossm} machineLine={graph.machineLine} notice={blocked} lineWidth={graph.overlay.lineWidth} span={graph.window} overlay={graph.overlay} />
                </TheaterGraph>
              )}
              {/* Where the hidden pane would appear, at the pane's padding so they do not jump. */}
              {inTheater && !showControls && theaterToggles({ position: "absolute", left: "var(--space-3)", top: "var(--space-3)" })}
              {inTheater && (
                <Button
                  variant="surface"
                  onClick={leaveTheater}
                  style={{ position: "absolute", top: "var(--space-3)", right: "var(--space-3)" }}
                >
                  <ExitFullScreenIcon /> Exit
                </Button>
              )}
            </Box>
          )}
          {inTheater && mode === "funscript" && played && graph.theaterMinimap && (
            <PlayerMinimap actions={playedActions} markers={markers} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} span={graph.window} />
          )}
        </>
      ) : (
        <Flex direction="column" align="center" justify="center" gap="3" flexGrow="1">
          <Text size="2" color="gray">
            {mode === "funscript" ? "Open a video or audio file to play it with the funscript." : "Open a video or audio file to play it here."}
          </Text>
          <Button variant="soft" onClick={chooseVideo}>
            <UploadIcon /> Open media
          </Button>
        </Flex>
      )}
      {silent.url && <audio
        {...mediaProps}
        src={silent.url}
        onLoadedMetadata={silent.onLoadedMetadata}
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
                    silent.drop("close");
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
            {graph.shown && <Box position="relative" flexShrink="0">
              <ScriptPreview script={played} chapters={markers.chapters} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} ossm={ossm} machineLine={graph.machineLine} notice={blocked} lineWidth={graph.overlay.lineWidth} span={graph.window} height={graph.height} />
              <ResizeGrip edge="top" onPointerDown={dragGraphHeight} />
            </Box>}
            {graph.minimap && <PlayerMinimap actions={playedActions} markers={markers} speed={scriptSpeed} playhead={playhead} reverse={reverse} videoRef={videoRef} span={graph.window} />}
          </>
        ) : (
          <Flex align="center" justify="center" flexShrink="0" height={`${graph.height}px`} style={{ borderRadius: 6, background: "var(--gray-a2)" }}>
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
