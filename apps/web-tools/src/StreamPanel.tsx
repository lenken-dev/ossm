import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  Box,
  Button,
  Callout,
  Flex,
  Heading,
  SegmentedControl,
  Separator,
  Text,
} from "@radix-ui/themes";
import { ExclamationTriangleIcon, ReloadIcon, UploadIcon } from "@radix-ui/react-icons";
import { type ChartOverlay, type ChartSeries } from "./Chart";
import { LabeledSlider, UNIT_LABELS, getRecorder } from "./TrajectoryPanel";
import { type UnitMode } from "./hooks/useTrajectoryInputs";

/** A funscript's actions, sorted by time with duplicate timestamps dropped. */
export interface Funscript {
  name: string;
  /** Action times in ms */
  at: Uint32Array;
  /** Action positions, 0 (deep end) to 100 (shallow end) */
  pos: Float64Array;
}

const MAX_AT_MS = 0xffff_ffff;

/** Parse a .funscript file. Throws an `Error` with a readable message. */
export function parseFunscript(name: string, text: string): Funscript {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  const actions = (json as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) {
    throw new Error("No \"actions\" array found.");
  }

  const valid: { at: number; pos: number }[] = [];
  for (const action of actions) {
    const { at, pos } = (action ?? {}) as { at?: unknown; pos?: unknown };
    if (typeof at !== "number" || typeof pos !== "number") continue;
    if (!Number.isFinite(at) || !Number.isFinite(pos) || at < 0 || at > MAX_AT_MS) continue;
    valid.push({ at: Math.round(at), pos: Math.min(Math.max(pos, 0), 100) });
  }
  // Stable sort keeps the first of several actions sharing a timestamp.
  valid.sort((a, b) => a.at - b.at);
  const unique = valid.filter((a, i) => i === 0 || a.at !== valid[i - 1].at);
  if (unique.length < 2) {
    throw new Error("The script needs at least two actions with distinct times.");
  }

  return {
    name,
    at: Uint32Array.from(unique, (a) => a.at),
    pos: Float64Array.from(unique, (a) => a.pos),
  };
}

export function funscriptDuration(script: Funscript): number {
  return (script.at[script.at.length - 1] - script.at[0]) / 1000;
}

/**
 * Machine position of a streamed point (100 = shallow end), mirroring
 * `StrokeRange::stream_to_machine` in `crates/stream-engine/src/range.rs`.
 */
function streamToMachine(pos: number, depth: number, stroke: number): number {
  const clean = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0);
  const d = clean(depth);
  const strokeLength = d * clean(stroke);
  const shallow = d - strokeLength;
  return shallow + (1 - Math.min(Math.max(pos, 0), 100) / 100) * strokeLength;
}

interface StreamRequest {
  script: Funscript;
  depth: number;
  stroke: number;
  velocity: number;
  jerk: number;
  lookahead: number;
}

export interface StreamTrajectory {
  request: StreamRequest;
  /** Script time of sample 0, in seconds */
  startSecs: number;
  /** Time between samples, in seconds */
  dt: number;
  position: Float32Array;
  velocity: Float32Array;
  acceleration: Float32Array;
  /** Recording hit the sample cap before the machine came to rest */
  truncated: boolean;
  /** Wall-clock time spent recording, in ms */
  elapsedMs: number;
}

/** Time recorded past the last point for the machine to settle. */
const SETTLE_SECS = 10;
/** Upper bound on recorded script length (two hours at 10 ms per sample). */
const MAX_RECORD_SECS = 2 * 60 * 60;

function recordStream(request: StreamRequest): StreamTrajectory {
  const { script, depth, stroke, velocity, jerk, lookahead } = request;
  const rec = getRecorder();
  const tickMs = rec.timestep_ms();
  const scriptSamples = Math.floor(funscriptDuration(script) * 1000 / tickMs) + 1;
  const maxSamples = Math.min(
    scriptSamples + Math.ceil(SETTLE_SECS * 1000 / tickMs),
    Math.ceil(MAX_RECORD_SECS * 1000 / tickMs),
  );

  const t0 = performance.now();
  const result = rec.record_stream(
    script.at, script.pos, depth, stroke, velocity, jerk, lookahead, maxSamples,
  );
  // Each getter copies the array out of wasm memory.
  const position = result.position;
  const vel = result.velocity;
  const acceleration = result.acceleration;
  result.free();
  const elapsedMs = performance.now() - t0;

  return {
    request,
    startSecs: script.at[0] / 1000,
    dt: tickMs / 1000,
    position,
    velocity: vel,
    acceleration,
    truncated: position.length >= maxSamples,
    elapsedMs,
  };
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Records `script` with the given settings, debounced while they change. */
export function useStreamTrajectory(
  script: Funscript | null,
  inputs: { depth: number; stroke: number; velocity: number; jerk: number; lookahead: number },
) {
  const { depth, stroke, velocity, jerk, lookahead } = inputs;
  const request = useMemo(
    () => (script ? { script, depth, stroke, velocity, jerk, lookahead } : null),
    [script, depth, stroke, velocity, jerk, lookahead],
  );
  const debounced = useDebouncedValue(request, 120);
  // A new script is recorded right away; setting changes wait for the debounce.
  const effective = request?.script === debounced?.script ? debounced : request;
  return useMemo(() => (effective ? recordStream(effective) : null), [effective]);
}

export function trajectoryEndSecs(trajectory: StreamTrajectory): number {
  return trajectory.startSecs + Math.max(trajectory.position.length - 1, 0) * trajectory.dt;
}

export interface StreamStats {
  samples: number;
  duration: number;
  peakVel: number;
  peakAccel: number;
  elapsedMs: number;
  truncated: boolean;
}

function peakAbs(values: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < values.length; i++) {
    const v = Math.abs(values[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

export function useStreamStats(trajectory: StreamTrajectory | null, unitMode: UnitMode): StreamStats | null {
  const peaks = useMemo(
    () => trajectory && { vel: peakAbs(trajectory.velocity), accel: peakAbs(trajectory.acceleration) },
    [trajectory],
  );
  return useMemo(() => {
    if (!trajectory || !peaks || trajectory.position.length === 0) return null;
    const rec = getRecorder();
    const scale = unitMode === "absolute" ? rec.max_position_mm() - rec.min_position_mm() : 1;
    return {
      samples: trajectory.position.length,
      duration: (trajectory.position.length - 1) * trajectory.dt,
      peakVel: peaks.vel * scale,
      peakAccel: peaks.accel * scale,
      elapsedMs: trajectory.elapsedMs,
      truncated: trajectory.truncated,
    };
  }, [trajectory, peaks, unitMode]);
}

/** Beyond this many samples, a window is drawn as per-bucket min/max samples. */
const MAX_CHART_SAMPLES = 4000;

/**
 * Indices of the samples to draw from `i0` to `i1`: all of them, or for long
 * spans both endpoints plus each bucket's minimum and maximum, in time order.
 */
function sampleIndices(src: Float32Array, i0: number, i1: number): number[] {
  const count = i1 - i0 + 1;
  if (count <= MAX_CHART_SAMPLES) {
    return Array.from({ length: count }, (_, k) => i0 + k);
  }
  const bucket = Math.ceil(count / (MAX_CHART_SAMPLES / 2));
  const indices = [i0];
  for (let b = i0; b <= i1; b += bucket) {
    const end = Math.min(b + bucket - 1, i1);
    let minI = b;
    let maxI = b;
    for (let i = b + 1; i <= end; i++) {
      if (src[i] < src[minI]) minI = i;
      if (src[i] > src[maxI]) maxI = i;
    }
    for (const i of minI <= maxI ? [minI, maxI] : [maxI, minI]) {
      if (i > indices[indices.length - 1]) indices.push(i);
    }
  }
  if (indices[indices.length - 1] !== i1) indices.push(i1);
  return indices;
}

export interface StreamChart {
  series: ChartSeries;
  /** Sample times for this series, in script seconds */
  time: number[];
  overlay?: ChartOverlay;
}

/**
 * Charts for the samples between `fromSecs` and `toSecs` (script time), with
 * the funscript points in that span as a position overlay.
 */
export function useStreamCharts(
  trajectory: StreamTrajectory | null,
  fromSecs: number,
  toSecs: number,
  unitMode: UnitMode,
): StreamChart[] {
  const windowed = useMemo(() => {
    if (!trajectory || trajectory.position.length === 0) return null;
    const { startSecs, dt } = trajectory;
    const last = trajectory.position.length - 1;
    const i0 = Math.min(Math.max(Math.floor((fromSecs - startSecs) / dt), 0), last);
    const i1 = Math.min(Math.max(Math.ceil((toSecs - startSecs) / dt), i0), last);
    const series = [trajectory.position, trajectory.velocity, trajectory.acceleration].map((src) => {
      const indices = sampleIndices(src, i0, i1);
      return {
        time: indices.map((i) => startSecs + i * dt),
        values: indices.map((i) => src[i]),
      };
    });

    // Script points in the window, plus a neighbour on each side so the
    // dashed line reaches the edges.
    const { script, depth, stroke } = trajectory.request;
    const fromMs = (startSecs + i0 * dt) * 1000;
    const toMs = (startSecs + i1 * dt) * 1000;
    let p0 = 0;
    while (p0 < script.at.length - 1 && script.at[p0 + 1] < fromMs) p0++;
    let p1 = p0;
    while (p1 < script.at.length - 1 && script.at[p1] <= toMs) p1++;
    const overlayX: number[] = [];
    const overlayY: number[] = [];
    for (let p = p0; p <= p1; p++) {
      overlayX.push(script.at[p] / 1000);
      overlayY.push(streamToMachine(script.pos[p], depth, stroke));
    }

    return { series, overlayX, overlayY };
  }, [trajectory, fromSecs, toSecs]);

  const rec = getRecorder();
  const minPosMm = rec.min_position_mm();
  const rangeMm = rec.max_position_mm() - minPosMm;
  const isAbsolute = unitMode === "absolute";
  const units = UNIT_LABELS[unitMode];

  return useMemo((): StreamChart[] => {
    if (!windowed) return [];
    const scale = isAbsolute ? rangeMm : 1;
    const [position, velocity, acceleration] = windowed.series;
    return [
      {
        series: {
          key: "position",
          label: "Position",
          color: "#8b5cf6",
          data: position.values,
          scale,
          offset: isAbsolute ? minPosMm : 0,
          fixedDomain: isAbsolute ? [minPosMm, minPosMm + rangeMm] : [0, 1],
          unit: units.position,
        },
        time: position.time,
        overlay: { x: windowed.overlayX, data: windowed.overlayY, color: "#ec4899" },
      },
      {
        series: { key: "velocity", label: "Velocity", color: "#06b6d4", data: velocity.values, scale, offset: 0, unit: units.velocity },
        time: velocity.time,
      },
      {
        series: { key: "acceleration", label: "Acceleration", color: "#f59e0b", data: acceleration.values, scale, offset: 0, unit: units.acceleration },
        time: acceleration.time,
      },
    ];
  }, [windowed, isAbsolute, units, rangeMm, minPosMm]);
}

const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

/** Time axis ticks on whole seconds or minutes, at most about eight. */
export function timeTicks(min: number, max: number): number[] {
  const span = max - min;
  const step = TICK_STEPS.find((s) => span / s <= 8) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks: number[] = [];
  for (let k = Math.ceil(min / step); k * step <= max; k++) {
    // Rounded so sub-second steps do not accumulate float noise.
    ticks.push(Math.round(k * step * 10) / 10);
  }
  return ticks;
}

/** Format script time as `12.5s` or `3:07.5`. */
export function formatScriptTime(secs: number, decimals = 1): string {
  const factor = 10 ** decimals;
  const total = Math.round(Math.abs(secs) * factor) / factor;
  const sign = secs < 0 && total > 0 ? "-" : "";
  const minutes = Math.floor(total / 60);
  const rest = (total - minutes * 60).toFixed(decimals);
  if (minutes === 0) return `${sign}${rest}s`;
  return `${sign}${minutes}:${rest.padStart(decimals > 0 ? 3 + decimals : 2, "0")}`;
}

/** Axis tick label: whole seconds without decimals. */
export function formatTimeTick(secs: number): string {
  const whole = Math.abs(secs - Math.round(secs)) < 1e-6;
  return formatScriptTime(secs, whole ? 0 : 1);
}

interface StreamSidebarProps extends Omit<ComponentProps<typeof Box>, "children"> {
  script: Funscript | null;
  onScriptChange: (script: Funscript) => void;
  depth: number;
  onDepthChange: (v: number) => void;
  stroke: number;
  onStrokeChange: (v: number) => void;
  velocity: number;
  onVelocityChange: (v: number) => void;
  jerk: number;
  onJerkChange: (v: number) => void;
  lookahead: number;
  onLookaheadChange: (v: number) => void;
  compact?: boolean;
  unitMode?: UnitMode;
  onUnitModeChange?: (v: UnitMode) => void;
  onResetDefaults?: () => void;
  stats?: StreamStats | null;
}

export function StreamSidebar({
  script,
  onScriptChange,
  depth,
  onDepthChange,
  stroke,
  onStrokeChange,
  velocity,
  onVelocityChange,
  jerk,
  onJerkChange,
  lookahead,
  onLookaheadChange,
  compact = false,
  unitMode,
  onUnitModeChange,
  onResetDefaults,
  stats,
  ...boxProps
}: StreamSidebarProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  // Only the latest selected file may update the script or the error.
  const loadGeneration = useRef(0);
  // Reads still pending on unmount must not replace a later selection.
  useEffect(() => () => void loadGeneration.current++, []);
  const [error, setError] = useState<string | null>(null);
  const isAbsolute = unitMode === "absolute";

  const loadFile = async (file: File) => {
    const generation = ++loadGeneration.current;
    let script: Funscript;
    try {
      script = parseFunscript(file.name, await file.text());
    } catch (e) {
      if (generation === loadGeneration.current) {
        setError(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    if (generation !== loadGeneration.current) return;
    onScriptChange(script);
    setError(null);
  };

  return (
    <Box {...boxProps}>
      <Flex direction="column" gap="4">
        <Heading size="4">Streaming Trajectory</Heading>
        <Separator size="4" />

        <Flex direction="column" gap="2">
          <input
            ref={fileRef}
            type="file"
            accept=".funscript,.json,application/json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void loadFile(file);
            }}
          />
          <Button variant="soft" style={{ width: "100%" }} onClick={() => fileRef.current?.click()}>
            <UploadIcon /> Load funscript
          </Button>
          {script && (
            <Flex direction="column" gap="1">
              <Text size="1" weight="medium" truncate title={script.name}>{script.name}</Text>
              <Flex justify="between">
                <Text size="1" color="gray">Points</Text>
                <Text size="1">{script.at.length.toLocaleString()}</Text>
              </Flex>
              <Flex justify="between">
                <Text size="1" color="gray">Duration</Text>
                <Text size="1">{formatScriptTime(funscriptDuration(script))}</Text>
              </Flex>
            </Flex>
          )}
          {error && (
            <Callout.Root color="red" size="1">
              <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
        </Flex>

        <Separator size="4" />

        <LabeledSlider label="Depth" value={depth} display={`${(depth * 100).toFixed(0)}%`} min={0} max={1} step={0.01} onChange={onDepthChange} />
        <LabeledSlider label="Stroke" value={stroke} display={`${(stroke * 100).toFixed(0)}%`} min={0} max={1} step={0.01} onChange={onStrokeChange} />
        <LabeledSlider label="Velocity" value={velocity} display={`${(velocity * 100).toFixed(0)}%`} min={0} max={1} step={0.01} onChange={onVelocityChange} />
        <LabeledSlider label="Jerk" value={jerk} display={`${(jerk * 100).toFixed(0)}%`} min={0} max={1} step={0.01} onChange={onJerkChange} />
        <LabeledSlider
          label="Look-ahead"
          value={lookahead}
          display={lookahead === 0 ? "Player" : `${lookahead} point${lookahead === 1 ? "" : "s"}`}
          min={0}
          max={8}
          step={1}
          onChange={onLookaheadChange}
        />

        {!compact && unitMode != null && onUnitModeChange && (
          <>
            <Separator size="4" />
            <Box>
              <Text size="2" weight="medium" mb="1" as="label">Units</Text>
              <SegmentedControl.Root
                value={unitMode}
                onValueChange={(v) => onUnitModeChange(v as UnitMode)}
                style={{ width: "100%" }}
              >
                <SegmentedControl.Item value="relative">Relative</SegmentedControl.Item>
                <SegmentedControl.Item value="absolute">Absolute</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Box>
          </>
        )}

        {!compact && stats && (
          <>
            <Separator size="4" />
            <Flex direction="column" gap="2">
              <Flex justify="between">
                <Text size="1" color="gray">Recorded</Text>
                <Text size="1">{formatScriptTime(stats.duration, 2)}</Text>
              </Flex>
              <Flex justify="between">
                <Text size="1" color="gray">Peak velocity</Text>
                <Text size="1">
                  {isAbsolute ? `${stats.peakVel.toFixed(1)} mm/s` : `${stats.peakVel.toFixed(3)} /s`}
                </Text>
              </Flex>
              <Flex justify="between">
                <Text size="1" color="gray">Peak accel</Text>
                <Text size="1">
                  {isAbsolute ? `${stats.peakAccel.toFixed(0)} mm/s²` : `${stats.peakAccel.toFixed(2)} /s²`}
                </Text>
              </Flex>
              <Flex justify="between">
                <Text size="1" color="gray">Samples</Text>
                <Text size="1">{stats.samples.toLocaleString()}</Text>
              </Flex>
              <Flex justify="between">
                <Text size="1" color="gray">Compute time</Text>
                <Text size="1">{stats.elapsedMs.toFixed(0)} ms</Text>
              </Flex>
              {stats.truncated && (
                <Text size="1" color="amber">
                  Recording stopped at the sample limit before the machine came to rest.
                </Text>
              )}
            </Flex>
          </>
        )}
        {onResetDefaults && (
          <>
            <Separator size="4" />
            <Button variant="outline" style={{ width: "100%" }} onClick={onResetDefaults}>
              <ReloadIcon /> Reset Defaults
            </Button>
          </>
        )}
      </Flex>
    </Box>
  );
}
