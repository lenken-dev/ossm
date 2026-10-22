import { LabeledSlider, SwitchRow } from "../widgets";

/** How the script plays. */
export interface PlaybackPrefs {
  /** How fast the script plays against the video, which keeps its own speed. */
  speed: number;
  reverse: boolean;
  simplified: boolean;
  /** The script follows the media's playhead; otherwise it keeps its own and only plays and pauses with the media. */
  synced: boolean;
  /** Start the media, and with it the script, over at its end; the seek back reopens the stream. */
  looped: boolean;
}

/**
 * The Funscript section of the controls: how fast the script plays against
 * the media, reversed, simplified, synced with the media's playhead or on its
 * own clock, and looped. All but Loop change only while the media is paused.
 */
export function ScriptSettings({ paused, prefs, onChange }: {
  paused: boolean;
  prefs: PlaybackPrefs;
  onChange: (prefs: PlaybackPrefs) => void;
}) {
  const set = (patch: Partial<PlaybackPrefs>) => onChange({ ...prefs, ...patch });
  return (
    <>
      <LabeledSlider
        label="Script speed"
        value={prefs.speed}
        display={`x${prefs.speed}`}
        min={0.25}
        max={2}
        step={0.05}
        disabled={!paused}
        onChange={(v) => set({ speed: Math.round(v * 100) / 100 })}
      />
      <SwitchRow label="Reverse" checked={prefs.reverse} disabled={!paused} onCheckedChange={(reverse) => set({ reverse })} />
      <SwitchRow label="Simplify" checked={prefs.simplified} disabled={!paused} onCheckedChange={(simplified) => set({ simplified })} />
      <SwitchRow label="Sync with media" checked={prefs.synced} disabled={!paused} onCheckedChange={(synced) => set({ synced })} />
      <SwitchRow label="Loop" checked={prefs.looped} onCheckedChange={(looped) => set({ looped })} />
    </>
  );
}
