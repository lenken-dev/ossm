import { Box, Button, Callout, Flex, SegmentedControl, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, HomeIcon } from "@radix-ui/react-icons";
import { usePersistedState } from "../hooks/usePersistedState";
import { useOssm } from "../player/ble";
import { GraphLayout } from "./GraphPage";

type PlayerMode = "pattern" | "funscript";

export default function PlayerPage() {
  const [mode, setMode] = usePersistedState<PlayerMode>("ossm:playerMode", "pattern");
  const { ossm, state, connecting, error, connect, disconnect } = useOssm();

  const sidebar = (
    <>
      <Box p="3" pb="0">
        <SegmentedControl.Root
          value={mode}
          onValueChange={(v) => setMode(v as PlayerMode)}
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
      </Flex>
    </>
  );

  const content = (
    <Flex align="center" justify="center" p="6" height="100%">
      <Text size="2" color="gray">
        {ossm ? `Connected to ${ossm.name}.` : "Connect to an OSSM running the ossm-rs firmware."}
      </Text>
    </Flex>
  );

  return <GraphLayout sidebar={sidebar} content={content} />;
}
