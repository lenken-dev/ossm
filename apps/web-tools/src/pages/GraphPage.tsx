import { useState, type ReactNode } from "react";
import { Box, Card, Flex, IconButton, SegmentedControl, Slider, Text } from "@radix-ui/themes";
import { ChevronLeftIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import { useAppearance } from "../hooks/useAppearance";
import { useIsMobile } from "../hooks/useIsMobile";
import { usePersistedState } from "../hooks/usePersistedState";
import { useStreamInputs } from "../hooks/useStreamInputs";
import { useTrajectoryInputs } from "../hooks/useTrajectoryInputs";
import { Chart, type ChartOverlay, type ChartSeries } from "../Chart";
import { TrajectorySidebar, useTrajectoryData } from "../TrajectoryPanel";
import {
  StreamSidebar,
  formatScriptTime,
  formatTimeTick,
  trajectoryEndSecs,
  timeTicks,
  useStreamCharts,
  useStreamStats,
  useStreamTrajectory,
  type Funscript,
} from "../StreamPanel";
import styles from "./GraphPage.module.css";

type GraphMode = "pattern" | "stream";

export default function GraphPage() {
  const [mode, setMode] = usePersistedState<GraphMode>("ossm:graphMode", "pattern");
  // Kept here so the loaded script survives switching modes.
  const [script, setScript] = useState<Funscript | null>(null);

  const modeSwitch = (
    <Box p="3" pb="0">
      <SegmentedControl.Root
        value={mode}
        onValueChange={(v) => setMode(v as GraphMode)}
        style={{ width: "100%" }}
      >
        <SegmentedControl.Item value="pattern">Pattern</SegmentedControl.Item>
        <SegmentedControl.Item value="stream">Streaming</SegmentedControl.Item>
      </SegmentedControl.Root>
    </Box>
  );

  return mode === "stream" ? (
    <StreamGraph modeSwitch={modeSwitch} script={script} onScriptChange={setScript} />
  ) : (
    <PatternGraph modeSwitch={modeSwitch} />
  );
}

function GraphLayout({ sidebar, content }: { sidebar: ReactNode; content: ReactNode }) {
  const isMobile = useIsMobile();
  return (
    <Flex
      direction={isMobile ? "column-reverse" : "row"}
      className={styles.root}
    >
      <Box className={isMobile ? styles.sidebarMobile : styles.sidebarDesktop}>
        {sidebar}
      </Box>
      <Box className={styles.content}>
        {content}
      </Box>
    </Flex>
  );
}

function ChartCard({
  series,
  xData,
  formatXTick,
  xTicks,
  overlay,
}: {
  series: ChartSeries;
  xData: number[];
  formatXTick: (v: number) => string;
  xTicks?: (min: number, max: number) => number[];
  overlay?: ChartOverlay;
}) {
  const [appearance] = useAppearance();
  return (
    <Card size="2">
      <Flex align="center" gap="2" mb="2">
        <Box
          className={styles.legendSwatch}
          style={{ backgroundColor: series.color }}
        />
        <Text size="2" weight="medium">{series.label}</Text>
        {series.unit && <Text size="1" color="gray">({series.unit})</Text>}
        {overlay && (
          <>
            <Box
              ml="3"
              className={styles.legendDot}
              style={{ backgroundColor: overlay.color }}
            />
            <Text size="1" color="gray">Script points</Text>
          </>
        )}
      </Flex>
      <Chart.Canvas
        series={[series]}
        xData={xData}
        focused={series.key}
        appearance={appearance}
        height={180}
        formatXTick={formatXTick}
        xTicks={xTicks}
        overlay={overlay}
      />
    </Card>
  );
}

const formatSecondsTick = (v: number) => `${Math.round(v)}s`;

function PatternGraph({ modeSwitch }: { modeSwitch: ReactNode }) {
  const isMobile = useIsMobile();
  const inputs = useTrajectoryInputs();
  const { data, chartSeries, stats } = useTrajectoryData(inputs);

  const charts = (
    <Flex direction="column" p="3" gap="3">
      {chartSeries.map((s) => (
        <ChartCard key={s.key} series={s} xData={data.time} formatXTick={formatSecondsTick} />
      ))}
    </Flex>
  );

  const sidebar = (
    <>
      {modeSwitch}
      <TrajectorySidebar
        pattern={inputs.pattern}
        onPatternChange={inputs.setPattern}
        depth={inputs.depth}
        onDepthChange={inputs.setDepth}
        stroke={inputs.stroke}
        onStrokeChange={inputs.setStroke}
        velocity={inputs.velocity}
        onVelocityChange={inputs.setVelocity}
        sensation={inputs.sensation}
        onSensationChange={inputs.setSensation}
        unitMode={inputs.unitMode}
        onUnitModeChange={inputs.setUnitMode}
        duration={inputs.duration}
        onDurationValueChange={inputs.setDuration}
        stats={stats}
        onResetDefaults={inputs.resetDefaults}
        compact={isMobile}
        p="3"
      />
    </>
  );

  return <GraphLayout sidebar={sidebar} content={charts} />;
}

/** Window lengths in seconds; 0 shows the whole recording. */
const WINDOW_OPTIONS = [5, 10, 30, 60, 0];

function StreamGraph({
  modeSwitch,
  script,
  onScriptChange,
}: {
  modeSwitch: ReactNode;
  script: Funscript | null;
  onScriptChange: (script: Funscript) => void;
}) {
  const isMobile = useIsMobile();
  const inputs = useStreamInputs();
  const trajectory = useStreamTrajectory(script, inputs);
  const stats = useStreamStats(trajectory, inputs.unitMode);
  const [windowStart, setWindowStart] = useState(0);

  const startSecs = trajectory?.startSecs ?? 0;
  const endSecs = trajectory ? trajectoryEndSecs(trajectory) : 0;
  const span = inputs.windowSecs > 0 ? Math.min(inputs.windowSecs, endSecs - startSecs) : endSecs - startSecs;
  const maxStart = Math.max(endSecs - span, startSecs);
  const from = Math.min(Math.max(windowStart, startSecs), maxStart);
  const to = from + span;

  const charts = useStreamCharts(trajectory, from, to, inputs.unitMode);

  const handleScriptChange = (next: Funscript) => {
    setWindowStart(next.at[0] / 1000);
    onScriptChange(next);
  };

  const shiftWindow = (direction: number) =>
    setWindowStart(Math.min(Math.max(from + direction * span, startSecs), maxStart));

  const content = !trajectory ? (
    <Flex align="center" justify="center" p="6" height="100%">
      <Text size="2" color="gray">
        Load a .funscript file to plan its streamed trajectory.
      </Text>
    </Flex>
  ) : (
    <Flex direction="column" p="3" gap="3">
      <Card size="2">
        <Flex direction="column" gap="3">
          <Flex align="center" justify="between" gap="3" wrap="wrap">
            <SegmentedControl.Root
              value={String(inputs.windowSecs)}
              onValueChange={(v) => inputs.setWindowSecs(Number(v))}
              size="1"
            >
              {WINDOW_OPTIONS.map((secs) => (
                <SegmentedControl.Item key={secs} value={String(secs)}>
                  {secs > 0 ? `${secs}s` : "All"}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
            <Text size="2" color="gray">
              {formatScriptTime(from)} – {formatScriptTime(to)} of {formatScriptTime(endSecs)}
            </Text>
          </Flex>
          <Flex align="center" gap="2">
            <IconButton
              size="1"
              variant="soft"
              aria-label="Previous window"
              disabled={from <= startSecs}
              onClick={() => shiftWindow(-1)}
            >
              <ChevronLeftIcon />
            </IconButton>
            <Slider
              min={startSecs}
              max={maxStart}
              step={0.1}
              value={[from]}
              disabled={maxStart <= startSecs}
              onValueChange={([v]) => setWindowStart(v)}
            />
            <IconButton
              size="1"
              variant="soft"
              aria-label="Next window"
              disabled={from >= maxStart}
              onClick={() => shiftWindow(1)}
            >
              <ChevronRightIcon />
            </IconButton>
          </Flex>
        </Flex>
      </Card>
      {charts.map((c) => (
        <ChartCard
          key={c.series.key}
          series={c.series}
          xData={c.time}
          formatXTick={formatTimeTick}
          xTicks={timeTicks}
          overlay={c.overlay}
        />
      ))}
    </Flex>
  );

  const sidebar = (
    <>
      {modeSwitch}
      <StreamSidebar
        script={script}
        onScriptChange={handleScriptChange}
        depth={inputs.depth}
        onDepthChange={inputs.setDepth}
        stroke={inputs.stroke}
        onStrokeChange={inputs.setStroke}
        velocity={inputs.velocity}
        onVelocityChange={inputs.setVelocity}
        jerk={inputs.jerk}
        onJerkChange={inputs.setJerk}
        lookahead={inputs.lookahead}
        onLookaheadChange={inputs.setLookahead}
        unitMode={inputs.unitMode}
        onUnitModeChange={inputs.setUnitMode}
        stats={stats}
        onResetDefaults={inputs.resetDefaults}
        compact={isMobile}
        p="3"
      />
    </>
  );

  return <GraphLayout sidebar={sidebar} content={content} />;
}
