import { LabeledSlider, SwitchRow } from "../widgets";

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
      <SwitchRow label="Reverse" checked={reverse} disabled={!paused} onCheckedChange={setReverse} />
      <SwitchRow label="Simplify" checked={simplified} disabled={!paused} onCheckedChange={setSimplified} />
      <SwitchRow label="Sync with media" checked={synced} disabled={!paused} onCheckedChange={onSynced} />
      <SwitchRow label="Loop" checked={looped} onCheckedChange={setLooped} />
    </>
  );
}
