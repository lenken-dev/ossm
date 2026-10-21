import { useMemo } from "react";
import { DataList, Separator, TextField } from "@radix-ui/themes";
import { usePersistedState } from "../hooks/usePersistedState";
import { FIRMWARE_RANGE_MM, RANGE_KEY, useFollow } from "../hooks/useFollow";
import { LabeledSlider } from "../TrajectoryPanel";
import type { Action } from "../funscript/model";
import { SectionHeader } from "../funscript/widgets";

/**
 * The sidebar's Speed Calculator: the fastest full strokes the machine
 * follows at a target speed and sensation, from the firmware's motion, and
 * the machine speed the stats' points, `picked` of `actions`, need; of the
 * selected points when `selectionOn`. Its settings are kept across reloads.
 */
export function SpeedCalculator({ actions, picked, selectionOn }: { actions: Action[]; picked: number[]; selectionOn: boolean }) {
  /** The calculator's machine range, in mm, shared with the player's; the share of it the stroke range takes (depth times stroke), its speed and sensation settings, in percent. */
  const [calcShown, setCalcShown] = usePersistedState("ossm:editorCalcShown", false, localStorage);
  const [rangeMm, setRangeMm] = usePersistedState(RANGE_KEY, FIRMWARE_RANGE_MM, localStorage);
  const [calcSpeed, setCalcSpeed] = usePersistedState("ossm:editorCalcSpeed", 100, localStorage);
  const [calcStroke, setCalcStroke] = usePersistedState("ossm:editorCalcStroke", 100, localStorage);
  const [calcSensation, setCalcSensation] = usePersistedState("ossm:editorCalcSensation", 50, localStorage);
  // Only the stroke range's length matters, so it reaches from the out end.
  const calcMax = useFollow(useMemo(() => ({ kind: "max" as const, settings: { rangeMm, depth: calcStroke / 100, stroke: 1, speed: calcSpeed / 100, jerk: calcSensation / 100 } }), [rangeMm, calcStroke, calcSpeed, calcSensation]));
  /** The speed setting the calculator's points need with its other settings. */
  const calcNeeded = useFollow(useMemo(() => {
    if (!calcShown || picked.length < 2) return null;
    const points = picked.map((i) => actions[i]);
    const script = { name: "", at: Uint32Array.from(points, (a) => a.at), pos: Float64Array.from(points, (a) => a.pos) };
    return { kind: "script" as const, script, rate: 1, settings: { rangeMm, depth: calcStroke / 100, stroke: 1, jerk: calcSensation / 100 }, speed: 1 };
  }, [calcShown, actions, picked, rangeMm, calcStroke, calcSensation]))?.needed;

  return (
    <>
      {/* The fastest full strokes the machine follows at a target speed and sensation, from the firmware's motion. */}
      <Separator size="4" />
      <SectionHeader title="Speed Calculator" open={calcShown} setOpen={setCalcShown} summary={`${calcMax ?? "…"}/s max`} />
      {calcShown && <>
        {/* Typing keeps the last range from 10 mm on. */}
        <TextField.Root type="number" min={10} step="any" aria-label="Machine range" defaultValue={rangeMm} onChange={(e) => Number(e.target.value) >= 10 && setRangeMm(Number(e.target.value))}>
          <TextField.Slot side="left">Machine range</TextField.Slot>
          <TextField.Slot side="right">mm</TextField.Slot>
        </TextField.Root>
        <LabeledSlider label="Stroke range" value={calcStroke} display={`${calcStroke}%`} min={1} max={100} step={1} onChange={setCalcStroke} />
        <LabeledSlider label="Speed" value={calcSpeed} display={`${calcSpeed}%`} min={0} max={100} step={1} onChange={setCalcSpeed} />
        <LabeledSlider label="Sensation" value={calcSensation} display={`${calcSensation}%`} min={0} max={100} step={1} ends={["Smooth", "Hard"]} onChange={setCalcSensation} />
        <DataList.Root size="2">
          <DataList.Item>
            <DataList.Label color="gray">Max funscript speed</DataList.Label>
            <DataList.Value>{calcMax ?? "…"}/s</DataList.Value>
          </DataList.Item>
          {/* Of the stats' points, at least two. */}
          {picked.length > 1 && (
            <DataList.Item title={`The lowest speed at which the machine reaches 95% of the ${selectionOn ? "selected" : "script's"} points on time, with the stroke range and sensation above.${calcNeeded === null ? " Raise the sensation or shorten the stroke range." : ""}`}>
              <DataList.Label color="gray">Machine speed needed</DataList.Label>
              <DataList.Value>{calcNeeded === undefined ? "…" : calcNeeded === null ? "Over 100%" : `${calcNeeded}%`}</DataList.Value>
            </DataList.Item>
          )}
        </DataList.Root>
      </>}
    </>
  );
}
