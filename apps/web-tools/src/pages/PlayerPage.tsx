import { useEffect, useRef, useState } from "react";
import { Box, Button, Callout, Flex, SegmentedControl, Select, Separator, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, HomeIcon, StopIcon, UploadIcon } from "@radix-ui/react-icons";
import { usePersistedState } from "../hooks/usePersistedState";
import { log, useOssm, type Ossm, type OssmState, type PatternInfo } from "../player/ble";
import { LabeledSlider } from "../TrajectoryPanel";
import { GraphLayout } from "./GraphPage";

type PlayerMode = "pattern" | "funscript";

/** How long a slider shows the user's value before following the device again; the device reports settings at least once a second. */
const PENDING_MS = 1500;

export default function PlayerPage() {
  const [mode, setMode] = usePersistedState<PlayerMode>("ossm:playerMode", "pattern");
  const { ossm, state, connecting, error, connect, disconnect } = useOssm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!videoFile) return;
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  // Files are assigned by type; only what was picked is replaced.
  const openFiles = (files: FileList) => {
    for (const file of files) {
      if (file.type.startsWith("video/")) setVideoFile(file);
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
      </Flex>
    </>
  );

  const content = (
    <Flex direction="column" gap="3" p="3" height="100%">
      <input
        ref={fileRef}
        type="file"
        accept="video/*"
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
            src={videoUrl}
            controls
            style={{ width: "100%", minHeight: 0, flex: 1, background: "black" }}
          />
        </>
      ) : (
        <Flex direction="column" align="center" justify="center" gap="3" flexGrow="1">
          <Text size="2" color="gray">Open a video to play it here.</Text>
          <Button variant="soft" onClick={() => fileRef.current?.click()}>
            <UploadIcon /> Open video
          </Button>
        </Flex>
      )}
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
