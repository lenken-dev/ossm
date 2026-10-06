import { useEffect, useRef, useState, type RefObject } from "react";
import { Box, Button, Callout, Flex, SegmentedControl, Select, Separator, Switch, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, HomeIcon, StopIcon, UploadIcon } from "@radix-ui/react-icons";
import { bisectLeft } from "d3";
import { useAppearance } from "../hooks/useAppearance";
import { usePersistedState } from "../hooks/usePersistedState";
import { log, useOssm, type Ossm, type OssmState, type PatternInfo } from "../player/ble";
import { parseFunscript, type Funscript } from "../StreamPanel";
import { LabeledSlider } from "../TrajectoryPanel";
import { GraphLayout } from "./GraphPage";

type PlayerMode = "pattern" | "funscript";

/** How long a slider shows the user's value before following the device again; the device reports settings at least once a second. */
const PENDING_MS = 1500;

/** Preview graph height and the window it shows around the video time, in ms. */
const PREVIEW_HEIGHT = 140;
const PREVIEW_BEFORE_MS = 2000;
const PREVIEW_AFTER_MS = 8000;

export default function PlayerPage() {
  const [mode, setMode] = usePersistedState<PlayerMode>("ossm:playerMode", "pattern");
  const { ossm, state, connecting, error, connect, disconnect } = useOssm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(true);
  const syncPaused = (e: { currentTarget: HTMLVideoElement }) => setPaused(e.currentTarget.paused);
  const [script, setScript] = useState<Funscript | null>(null);
  const [scriptError, setScriptError] = useState<string | null>(null);
  // Only the latest picked script may replace the script or the error.
  const scriptGeneration = useRef(0);
  const [reverse, setReverse] = useState(false);
  /** Sync offset in ms; positive moves the machine earlier. Never sent to the device. */
  const [offset, setOffset] = usePersistedState("ossm:playerOffset", 0);

  useEffect(() => {
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  const loadScript = async (file: File) => {
    const generation = ++scriptGeneration.current;
    try {
      const parsed = parseFunscript(file.name, await file.text());
      if (generation !== scriptGeneration.current) return;
      setScript(parsed);
      setScriptError(null);
    } catch (e) {
      if (generation !== scriptGeneration.current) return;
      setScriptError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // Files are assigned by type; only what was picked is replaced.
  const openFiles = (files: FileList) => {
    for (const file of files) {
      if (file.type.startsWith("video/")) setVideoFile(file);
      else if (mode === "funscript" && file.name.toLowerCase().endsWith(".funscript")) void loadScript(file);
    }
  };

  const sidebar = (
    <>
      <Box p="3" pb="0">
        <SegmentedControl.Root
          value={mode}
          onValueChange={(v) => {
            log(`mode ${v}`);
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
            <Button
              variant="soft"
              disabled={state?.state === "homing"}
              onClick={() => void ossm.command("go:home")}
            >
              <HomeIcon /> Home
            </Button>
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
            <PatternControls ossm={ossm} state={state} />
          </>
        )}
        {mode === "funscript" && (
          <>
            <Separator size="4" />
            <Text size="2" weight="medium" truncate title={script?.name}>
              {script?.name ?? "No funscript loaded"}
            </Text>
            {scriptError && (
              <Callout.Root color="red" size="1">
                <Callout.Icon>
                  <ExclamationTriangleIcon />
                </Callout.Icon>
                <Callout.Text>{scriptError}</Callout.Text>
              </Callout.Root>
            )}
            {ossm && ossm.lookahead === 0 ? (
              <Text size="2" color="gray">This firmware cannot stream.</Text>
            ) : ossm && state && (
              <>
                <SettingSlider ossm={ossm} setting="depth" label="Depth" value={state.depth} />
                <SettingSlider ossm={ossm} setting="stroke" label="Stroke" value={state.stroke} />
                <SettingSlider ossm={ossm} setting="speed" label="Speed" value={state.speed} />
                <SettingSlider ossm={ossm} setting="jerk" label="Jerk" value={state.jerk} />
              </>
            )}
            <LabeledSlider
              label="Sync offset"
              value={offset}
              display={`${offset > 0 ? "+" : ""}${offset} ms`}
              min={-500}
              max={500}
              step={5}
              onChange={setOffset}
            />
            <Text as="label" size="2" weight="medium">
              <Flex align="center" justify="between" gap="2">
                Reverse
                <Switch checked={reverse} disabled={!paused} onCheckedChange={setReverse} />
              </Flex>
            </Text>
          </>
        )}
      </Flex>
    </>
  );

  const content = (
    <Flex direction="column" gap="3" p="3" height="100%">
      <input
        ref={fileRef}
        type="file"
        accept={mode === "funscript" ? "video/*,.funscript" : "video/*"}
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) openFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {videoUrl ? (
        <>
          <Flex align="center" justify="between" gap="2">
            <Text size="2" weight="medium" truncate title={videoFile?.name}>{videoFile?.name}</Text>
            <Button variant="soft" onClick={() => fileRef.current?.click()}>
              <UploadIcon /> Open
            </Button>
          </Flex>
          <video
            ref={videoRef}
            src={videoUrl}
            controls
            onPlay={syncPaused}
            onPause={syncPaused}
            onEmptied={syncPaused}
            style={{ width: "100%", minHeight: 0, flex: 1, background: "black" }}
          />
        </>
      ) : (
        <Flex direction="column" align="center" justify="center" gap="3" flexGrow="1">
          <Text size="2" color="gray">
            {mode === "funscript" ? "Open a video and a funscript to play them here." : "Open a video to play it here."}
          </Text>
          <Button variant="soft" onClick={() => fileRef.current?.click()}>
            <UploadIcon /> Open video
          </Button>
        </Flex>
      )}
      {mode === "funscript" && script && <ScriptPreview script={script} reverse={reverse} videoRef={videoRef} />}
    </Flex>
  );

  return <GraphLayout sidebar={sidebar} content={content} />;
}

/** Pattern mode: play, adjust and stop the device's patterns. */
function PatternControls({ ossm, state }: { ossm: Ossm; state: OssmState }) {
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
          onValueChange={(v) => void ossm.command(`set:pattern:${v}`)}
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
      <SettingSlider ossm={ossm} setting="depth" label="Depth" value={state.depth} />
      <SettingSlider ossm={ossm} setting="stroke" label="Stroke" value={state.stroke} />
      <SettingSlider ossm={ossm} setting="speed" label="Speed" value={state.speed} />
      <SettingSlider ossm={ossm} setting="sensation" label="Sensation" value={state.sensation} />
      <Button variant="soft" color="red" onClick={() => void ossm.command("go:menu")}>
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
function SettingSlider({ ossm, setting, label, value }: {
  ossm: Ossm;
  setting: string;
  label: string;
  value: number;
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
      max={100}
      step={0.1}
      onChange={(v) => {
        const rounded = Math.round(v * 10) / 10;
        setPending(rounded);
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setPending(null), PENDING_MS);
        void ossm.command(`set:${setting}:${rounded}`);
      }}
    />
  );
}

/** The script's raw points around the video time, redrawn every animation frame. Works without a video (time 0). */
function ScriptPreview({ script, reverse, videoRef }: {
  script: Funscript;
  reverse: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const [appearance] = useAppearance();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(canvasRef.current!);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (width === 0) return;
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(PREVIEW_HEIGHT * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const isDark = appearance === "dark";
    const gridColor = isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.15)";
    const playheadColor = isDark ? "rgba(255,255,255,0.6)" : "rgba(0,0,0,0.4)";
    const lineColor = "#ec4899";
    const pad = 6;
    const y = (pos: number) => pad + (1 - (reverse ? 100 - pos : pos) / 100) * (PREVIEW_HEIGHT - 2 * pad);

    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const now = (videoRef.current?.currentTime ?? 0) * 1000;
      const from = now - PREVIEW_BEFORE_MS;
      const to = now + PREVIEW_AFTER_MS;
      const x = (at: number) => ((at - from) / (to - from)) * width;
      ctx.clearRect(0, 0, width, PREVIEW_HEIGHT);

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
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = first; i <= last; i++) ctx.lineTo(x(script.at[i]), y(script.pos[i]));
      ctx.stroke();
      for (let i = first; i <= last; i++) {
        ctx.beginPath();
        ctx.arc(x(script.at[i]), y(script.pos[i]), 3, 0, Math.PI * 2);
        ctx.fill();
      }

      const px = Math.round(x(now)) + 0.5;
      ctx.strokeStyle = playheadColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, PREVIEW_HEIGHT);
      ctx.stroke();
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [script, reverse, appearance, width, videoRef]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: "block",
        width: "100%",
        height: PREVIEW_HEIGHT,
        flexShrink: 0,
        borderRadius: 6,
        background: "var(--gray-a2)",
      }}
    />
  );
}
