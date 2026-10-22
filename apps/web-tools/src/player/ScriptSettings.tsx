import { Flex, Switch, Text } from "@radix-ui/themes";
import { LabeledSlider } from "../widgets";

/**
 * The Funscript section of the controls: how fast the script plays against
 * the media, reversed, simplified, synced with the media's playhead or on its
 * own clock, and looped. All but Loop change only while the media is paused.
 */
export function ScriptSettings({ paused, scriptSpeed, onScriptSpeed, reverse, setReverse, simplified, setSimplified, synced, onSynced, looped, setLooped }: {
  paused: boolean;
  scriptSpeed: number;
  /** The slider's value, unrounded. */
  onScriptSpeed: (v: number) => void;
  reverse: boolean;
  setReverse: (on: boolean) => void;
  simplified: boolean;
  setSimplified: (on: boolean) => void;
  synced: boolean;
  onSynced: (on: boolean) => void;
  looped: boolean;
  setLooped: (on: boolean) => void;
}) {
  return (
    <>
      <LabeledSlider
        label="Script speed"
        value={scriptSpeed}
        display={`x${scriptSpeed}`}
        min={0.25}
        max={2}
        step={0.05}
        disabled={!paused}
        onChange={onScriptSpeed}
      />
      <Text as="label" size="2" weight="medium">
        <Flex align="center" justify="between" gap="2">
          Reverse
          <Switch checked={reverse} disabled={!paused} onCheckedChange={setReverse} />
        </Flex>
      </Text>
      <Text as="label" size="2" weight="medium">
        <Flex align="center" justify="between" gap="2">
          Simplify
          <Switch checked={simplified} disabled={!paused} onCheckedChange={setSimplified} />
        </Flex>
      </Text>
      <Text as="label" size="2" weight="medium">
        <Flex align="center" justify="between" gap="2">
          Sync with media
          <Switch checked={synced} disabled={!paused} onCheckedChange={onSynced} />
        </Flex>
      </Text>
      <Text as="label" size="2" weight="medium">
        <Flex align="center" justify="between" gap="2">
          Loop
          <Switch checked={looped} onCheckedChange={setLooped} />
        </Flex>
      </Text>
    </>
  );
}
