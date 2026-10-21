import { useContext } from "react";
import { DataList, Text, TextField, Tooltip } from "@radix-ui/themes";
import { SectionHeader } from "../funscript/widgets";
import type { Funscript } from "../StreamPanel";
import type { FollowResult, FollowRequest } from "../follow";
import { PortalContainer } from "./controls";

/**
 * The Speed Calculator section of the controls: the machine range, and for
 * the played script the speed it needs at the machine's depth, stroke and
 * sensation, with the share of its points reached at the connected machine's
 * speed.
 */
export function PlayerCalculator({ open, setOpen, played, scriptSpeed, settings: calcSettings, calc, connected, rangeMm, machineRangeMm, setRangeMm }: {
  open: boolean;
  setOpen: (open: boolean) => void;
  played: Funscript | null;
  scriptSpeed: number;
  /** The machine's settings, 0–100. */
  settings: { depth: number; stroke: number; sensation: number; speed: number };
  /** The speed the script needs and the share of its points reached, undefined while worked out. */
  calc: FollowResult<Extract<FollowRequest, { kind: "script" }>> | undefined;
  /** A machine is connected, so it has a speed. */
  connected: boolean;
  rangeMm: number;
  /** The connected machine's travel, which replaces the range typed in. */
  machineRangeMm: number | null;
  setRangeMm: (mm: number) => void;
}) {
  const needed = calc?.needed;
  const container = useContext(PortalContainer);
  return (
    <>
      <SectionHeader title="Speed Calculator" open={open} setOpen={setOpen} />
      {open && <>
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
              container={container}
              content={`The lowest speed at which the machine reaches 95% of the script's points on time, at depth ${calcSettings.depth.toFixed(0)}%, stroke ${calcSettings.stroke.toFixed(0)}% and sensation ${calcSettings.sensation.toFixed(0)}%${scriptSpeed !== 1 ? ` played x${scriptSpeed}` : ""}.${needed === null ? " Raise the sensation or shorten the stroke." : ""}`}
            >
              <DataList.Item>
                <DataList.Label color="gray">Speed needed</DataList.Label>
                <DataList.Value>{needed === undefined ? "…" : needed === null ? "Over 100%" : `${needed}%`}</DataList.Value>
              </DataList.Item>
            </Tooltip>
            {/* Only the connected machine has a speed. */}
            {connected && calc && (
              <DataList.Item>
                <DataList.Label color="gray">Points reached</DataList.Label>
                <DataList.Value>{(calc.reached * 100).toFixed(1)}%</DataList.Value>
              </DataList.Item>
            )}
          </DataList.Root>
        </>}
      </>}
    </>
  );
}
