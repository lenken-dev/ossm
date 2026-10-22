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
import { UNIT_LABELS } from "./TrajectoryPanel";
import { getRecorder } from "./recorder";
import { LabeledSlider } from "./widgets";
import { funscriptDuration, readFunscript, type Funscript } from "./funscript/file";
import { formatScriptTime } from "./funscript/time";
import { type UnitMode } from "./hooks/useTrajectoryInputs";

/**
 * Machine position of a streamed point (100 = shallow end), mirroring
 * `StrokeRange::stream_to_machine` in `ossm/crates/stream-engine/src/range.rs`.
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
  const [error, setError] = useState<string | null>(null);
  const isAbsolute = unitMode === "absolute";

  const loadFile = async (file: File) => {
    try {
      onScriptChange(await readFunscript(file));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Box {...boxProps}>
      <Flex direction="column" gap="4">
        <Heading size="4">Funscript Trajectory</Heading>
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
