import { Button, Text } from "@radix-ui/themes";
import { MoveIcon } from "@radix-ui/react-icons";
import { LabeledSlider, SwitchRow } from "../widgets";
import { DEFAULT_OVERLAY, type OverlayStyle } from "./overlay";

/** Choices for the time after the video time, in s: by the second up to 30 s, then by 10 s. */
const AFTER_STOPS = [...Array.from({ length: 30 }, (_, i) => i + 1), 40, 50, 60, 70, 80, 90, 100, 110, 120];

/** How the graphs show. */
export interface GraphPrefs {
  shown: boolean;
  /** A minimap of the whole script below the graph. */
  minimap: boolean;
  /** A minimap of the whole script below the video in theater mode. */
  theaterMinimap: boolean;
  /** Trace the machine's position on the graph as a second line. */
  machineLine: boolean;
  /** Time both graphs show before and after the video time, in ms. */
  window: { before: number; after: number };
  /** Height of the graph below the video, in px. */
  height: number;
  overlay: OverlayStyle;
}
export const GRAPH_DEFAULTS: GraphPrefs = {
  shown: true,
  minimap: true,
  theaterMinimap: true,
  machineLine: false,
  window: { before: 2000, after: 8000 },
  height: 140,
  overlay: DEFAULT_OVERLAY,
};

/**
 * The Graph section of the controls: whether the graph and the minimap show,
 * the graph's line width, machine line and time before and after the
 * playhead; in theater mode also the background over the video and moving
 * and resizing the graph there, else a hint on resizing it below the video.
 */
export function GraphSettings({ prefs, onChange, theater, canArrange, onArrange }: {
  prefs: GraphPrefs;
  onChange: (prefs: GraphPrefs) => void;
  /** Theater mode, which has a minimap of its own. */
  theater: boolean;
  /** There is a graph over the video to move and resize. */
  canArrange: boolean;
  onArrange: () => void;
}) {
  const { shown, window: span, overlay } = prefs;
  const set = (patch: Partial<GraphPrefs>) => onChange({ ...prefs, ...patch });
  const minimap = theater ? "theaterMinimap" : "minimap";
  return (
    <>
      <SwitchRow label="Show graph" checked={shown} onCheckedChange={(shown) => set({ shown })} />
      <SwitchRow label="Show minimap" checked={prefs[minimap]} onCheckedChange={(on) => set({ [minimap]: on })} />
      {shown && (
        <>
          <LabeledSlider
            label="Line width"
            value={overlay.lineWidth}
            display={`${overlay.lineWidth} px`}
            min={1}
            max={8}
            step={0.5}
            onChange={(lineWidth) => set({ overlay: { ...overlay, lineWidth } })}
          />
          <SwitchRow label="Show machine line" checked={prefs.machineLine} onCheckedChange={(machineLine) => set({ machineLine })} />
          <LabeledSlider
            label="Before playhead"
            value={span.before}
            display={`${span.before / 1000} s`}
            min={0}
            max={10000}
            step={1000}
            onChange={(before) => set({ window: { ...span, before } })}
          />
          <LabeledSlider
            label="After playhead"
            value={Math.max(AFTER_STOPS.findIndex((s) => s * 1000 >= span.after), 0)}
            display={`${span.after / 1000} s`}
            min={0}
            max={AFTER_STOPS.length - 1}
            step={1}
            onChange={(i) => set({ window: { ...span, after: AFTER_STOPS[i] * 1000 } })}
          />
          {theater ? (
            <>
              <LabeledSlider
                label="Background"
                value={overlay.background}
                display={`${overlay.background}%`}
                min={0}
                max={100}
                step={5}
                onChange={(background) => set({ overlay: { ...overlay, background } })}
              />
              <Button variant="soft" disabled={!canArrange} onClick={onArrange}>
                <MoveIcon /> Move and resize
              </Button>
            </>
          ) : (
            <Text size="1" color="gray">Drag the top edge of the graph to change its height.</Text>
          )}
          {/* Back to the default look, size and time span. */}
          <Button variant="soft" color="gray" onClick={() => set({ overlay: GRAPH_DEFAULTS.overlay, height: GRAPH_DEFAULTS.height, window: GRAPH_DEFAULTS.window })}>
            Reset
          </Button>
        </>
      )}
    </>
  );
}
