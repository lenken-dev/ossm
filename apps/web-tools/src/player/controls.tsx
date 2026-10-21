import { createContext, useContext, useEffect, useRef, useState } from "react";
import { AlertDialog, Box, Button, Dialog, Flex, IconButton, Select, Text } from "@radix-ui/themes";
import { GearIcon, PauseIcon, StopIcon } from "@radix-ui/react-icons";
import { usePersistedState } from "../hooks/usePersistedState";
import { LabeledSlider } from "../TrajectoryPanel";
import { log, type Ossm, type OssmState, type PatternInfo } from "./ble";

/** Where dialogs, menus and tooltips open: the popout window's body while the controls are in it. */
export const PortalContainer = createContext<HTMLElement | undefined>(undefined);

/** How long a slider shows the user's value before following the device again; the device reports settings at least once a second. */
const PENDING_MS = 1500;

/** Where the machine moves along the depth and stroke sliders; out is towards home. */
export const DEPTH_ENDS: [string, string] = ["Out", "In"];
export const STROKE_ENDS: [string, string] = ["In", "Out"];

/** Pattern mode: play, adjust and stop the device's patterns. */
export function PatternControls({ ossm, state }: {
  ossm: Ossm;
  state: OssmState;
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

  const container = useContext(PortalContainer);
  return (
    <>
      <Box>
        <Text size="2" weight="medium" mb="1" as="div">Pattern</Text>
        <Select.Root
          value={selected == null ? "" : String(selected)}
          onValueChange={(v) => void ossm.command(`set:pattern:${v}`)}
        >
          <Select.Trigger placeholder="Choose a pattern" style={{ width: "100%" }} />
          <Select.Content container={container}>
            {patterns.map((p) => (
              <Select.Item key={p.idx} value={String(p.idx)}>{p.name}</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        {description && <Text size="1" color="gray" as="p" mt="1">{description}</Text>}
      </Box>
      <DepthStrokeSliders ossm={ossm} state={state} />
      <SettingSlider ossm={ossm} setting="speed" label="Speed" value={state.speed} />
      <SettingSlider ossm={ossm} setting="sensation" label="Sensation" value={state.sensation} />
      <Button
        variant="soft"
        disabled={state.speed <= 0}
        onClick={() => void ossm.command("set:speed:0")}
      >
        <PauseIcon /> Pause
      </Button>
      <Button
        variant="soft"
        color="red"
        size="3"
        style={{ height: 64 }}
        onClick={() => void ossm.command("go:menu")}
      >
        <StopIcon /> Stop
      </Button>
    </>
  );
}

/**
 * `value`, except the user's latest value for a while after a change, so
 * state reported before the device applied it does not make it jump back.
 * Returns the value to show and the change handler.
 */
function usePending(value: number): [number, (changed: number) => void] {
  const [pending, setPending] = useState<number | null>(null);
  const timer = useRef<number>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [pending ?? value, (changed) => {
    setPending(changed);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPending(null), PENDING_MS);
  }];
}

/**
 * A device setting (0–100). Follows the device's value, except that it shows
 * the user's latest value for a while after a change (see {@link usePending}).
 * Only user changes are written.
 */
export function SettingSlider({ ossm, setting, label, value, pending, max = 100, disabled, ends, onChange }: {
  ossm: Ossm;
  setting: string;
  label: string;
  value: number;
  /** The slider's {@link usePending} of `value`, for a parent that shows the value too. */
  pending?: [number, (changed: number) => void];
  max?: number;
  disabled?: boolean;
  ends?: [string, string];
  /** Called after each write is queued. */
  onChange?: () => void;
}) {
  const own = usePending(value);
  const [shown, change] = pending ?? own;

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
        change(rounded);
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
  const container = useContext(PortalContainer);
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
        <Dialog.Content maxWidth="360px" container={container}>
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
 * The depth and stroke sliders, and the stroke length in mm of the values
 * they show, on firmware that publishes its travel.
 */
function DepthStrokeSliders({ ossm, state, disabled, onDepth, onStroke }: {
  ossm: Ossm;
  state: OssmState;
  disabled?: boolean;
  onDepth?: () => void;
  onStroke?: () => void;
}) {
  const depth = usePending(state.depth);
  const stroke = usePending(state.stroke);
  // The stroke is a share of the depth (`StrokeRange` in ossm/crates/stream-engine/src/range.rs).
  const mm = ossm.travelMm === null ? null : (depth[0] / 100) * (stroke[0] / 100) * ossm.travelMm;
  return (
    <>
      <SettingSlider ossm={ossm} setting="depth" label="Depth" value={state.depth} pending={depth} ends={DEPTH_ENDS} disabled={disabled} onChange={onDepth} />
      <SettingSlider ossm={ossm} setting="stroke" label="Stroke" value={state.stroke} pending={stroke} ends={STROKE_ENDS} disabled={disabled} onChange={onStroke} />
      {mm !== null && <Text size="2" color="gray">Stroke length: {mm.toFixed(0)} mm</Text>}
    </>
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
export function SetupDialog({ ossm, state, speedLimit, setSpeedLimit, depthSliders, setDepthSliders, onDone, onClose }: {
  ossm: Ossm;
  state: OssmState;
  speedLimit: number;
  setSpeedLimit: (limit: number) => void;
  /** Depth and stroke sliders in the controls. */
  depthSliders: boolean;
  setDepthSliders: (on: boolean) => void;
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
  const container = useContext(PortalContainer);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && close()}>
      <Dialog.Content maxWidth="420px" container={container}>
        <Dialog.Title>Set depth and stroke</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          The machine follows the slider you move. Depth is the deepest point while playing; 100% extends the
          machine fully. Stroke sets the shallowest point.
        </Dialog.Description>
        <Flex direction="column" gap="3">
          <SpeedSlider ossm={ossm} value={state.speed} limit={speedLimit} setLimit={setSpeedLimit} />
          <DepthStrokeSliders ossm={ossm} state={state} disabled={still} onDepth={() => track(0)} onStroke={() => track(100)} />
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
        <Flex justify="between" gap="2" mt="4">
          {depthSliders ? (
            <Button variant="soft" color="gray" onClick={() => setDepthSliders(false)}>
              Hide sliders in controls
            </Button>
          ) : (
            <AlertDialog.Root>
              <AlertDialog.Trigger>
                <Button variant="soft" color="gray">Show sliders in controls</Button>
              </AlertDialog.Trigger>
              <AlertDialog.Content maxWidth="400px" container={container}>
                <AlertDialog.Title>Change depth while playing?</AlertDialog.Title>
                <AlertDialog.Description size="2">
                  The script plays between depth and stroke, so a depth that feels right in a shallow part of the
                  script goes that much deeper once the script does. Raise it only a little at a time.
                </AlertDialog.Description>
                <Flex gap="3" mt="4" justify="end">
                  <AlertDialog.Cancel>
                    <Button variant="soft" color="gray">Cancel</Button>
                  </AlertDialog.Cancel>
                  <AlertDialog.Action>
                    <Button color="red" onClick={() => setDepthSliders(true)}>Show sliders</Button>
                  </AlertDialog.Action>
                </Flex>
              </AlertDialog.Content>
            </AlertDialog.Root>
          )}
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
