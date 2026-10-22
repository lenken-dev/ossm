import { useContext, useEffect, useMemo } from "react";
import { DataList, TextField, Tooltip } from "@radix-ui/themes";
import { usePersistedState } from "../hooks/usePersistedState";
import { FIRMWARE_RANGE_MM, RANGE_KEY, useFollow } from "../hooks/useFollow";
import { LabeledSlider } from "../TrajectoryPanel";
import type { Funscript } from "../StreamPanel";
import { PortalContainer } from "../player/controls";
import { SectionHeader } from "./widgets";

/**
 * The Speed Calculator section of the player and the editor: the fastest
 * full strokes the machine follows at a speed and sensation, from the
 * firmware's motion, and for `script` played at `rate` the machine speed it
 * needs and the share of its points reached at the speed setting. Its
 * settings are kept across reloads and shared by both pages; a connected
 * `machine` replaces them, and its travel `machineRangeMm` the range.
 */
export function SpeedCalculator({ open, setOpen, script, rate = 1, selection = false, machine, machineRangeMm = null }: {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** The points to follow, at least two, or null. */
  script: Funscript | null;
  rate?: number;
  /** The script is the selected points. */
  selection?: boolean;
  /** The connected machine's settings, 0–100. */
  machine?: { depth: number; stroke: number; sensation: number; speed: number } | null;
  /** The connected machine's travel, in mm, once known. */
  machineRangeMm?: number | null;
}) {
  /** The machine range, in mm, shared by both pages; the share of it the stroke range takes, the speed and sensation settings, in percent. */
  const [savedRangeMm, setRangeMm] = usePersistedState(RANGE_KEY, FIRMWARE_RANGE_MM, localStorage);
  const [savedSpeed, setSpeed] = usePersistedState("ossm:calcSpeed", 100, localStorage);
  const [strokeRange, setStrokeRange] = usePersistedState("ossm:calcStroke", 100, localStorage);
  const [savedSensation, setSensation] = usePersistedState("ossm:calcSensation", 50, localStorage);
  const rangeMm = machineRangeMm ?? savedRangeMm;
  // Saved for when the machine is gone.
  useEffect(() => {
    if (machineRangeMm !== null) setRangeMm(machineRangeMm);
  }, [machineRangeMm, setRangeMm]);
  const speed = machine?.speed ?? savedSpeed;
  const sensation = machine?.sensation ?? savedSensation;
  // Only the stroke range's length matters, so without a machine it reaches from the out end.
  const depth = machine?.depth ?? strokeRange;
  const stroke = machine?.stroke ?? 100;
  const max = useFollow(useMemo(() => ({ kind: "max" as const, settings: { rangeMm, depth: depth / 100, stroke: stroke / 100, speed: speed / 100, jerk: sensation / 100 } }), [rangeMm, depth, stroke, speed, sensation]));
  /** The speed setting the script needs with the other settings, and the share of its points reached at the speed setting. */
  const calc = useFollow(useMemo(() => {
    if (!open || !script) return null;
    return { kind: "script" as const, script, rate, settings: { rangeMm, depth: depth / 100, stroke: stroke / 100, jerk: sensation / 100 }, speed: speed / 100 };
  }, [open, script, rate, rangeMm, depth, stroke, speed, sensation]));
  const needed = calc?.needed;
  const container = useContext(PortalContainer);

  return (
    <>
      <SectionHeader title="Speed Calculator" open={open} setOpen={setOpen} summary={`${max ?? "…"}/s max`} />
      {open && <>
        {/* Typing keeps the last range from 10 mm on. The connected machine's travel replaces it. */}
        <TextField.Root key={machineRangeMm} type="number" min={10} step="any" aria-label="Machine range" defaultValue={rangeMm} disabled={machineRangeMm !== null} onChange={(e) => Number(e.target.value) >= 10 && setRangeMm(Number(e.target.value))}>
          <TextField.Slot side="left">Machine range</TextField.Slot>
          <TextField.Slot side="right">mm</TextField.Slot>
        </TextField.Root>
        <LabeledSlider label="Stroke range" value={depth * stroke / 100} display={`${(depth * stroke / 100).toFixed(0)}%`} min={1} max={100} step={1} disabled={!!machine} onChange={setStrokeRange} />
        <LabeledSlider label="Speed" value={speed} display={`${speed.toFixed(0)}%`} min={0} max={100} step={1} disabled={!!machine} onChange={setSpeed} />
        <LabeledSlider label="Sensation" value={sensation} display={`${sensation.toFixed(0)}%`} min={0} max={100} step={1} ends={["Smooth", "Hard"]} disabled={!!machine} onChange={setSensation} />
        <DataList.Root size="2">
          <DataList.Item>
            <DataList.Label color="gray">Max funscript speed</DataList.Label>
            <DataList.Value>{max ?? "…"}/s</DataList.Value>
          </DataList.Item>
          {script && <>
            <Tooltip
              container={container}
              content={`The lowest speed at which the machine reaches 95% of the ${selection ? "selected" : "script's"} points on time, with the stroke range and sensation above${rate !== 1 ? `, played x${rate}` : ""}.${needed === null ? " Raise the sensation or shorten the stroke range." : ""}`}
            >
              <DataList.Item>
                <DataList.Label color="gray">Machine speed needed</DataList.Label>
                <DataList.Value>{needed === undefined ? "…" : needed === null ? "Over 100%" : `${needed}%`}</DataList.Value>
              </DataList.Item>
            </Tooltip>
            <DataList.Item>
              <DataList.Label color="gray">Points reached</DataList.Label>
              <DataList.Value>{calc ? `${(calc.reached * 100).toFixed(1)}%` : "…"}</DataList.Value>
            </DataList.Item>
          </>}
        </DataList.Root>
      </>}
    </>
  );
}
