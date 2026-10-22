import { Button, Text } from "@radix-ui/themes";
import { MoveIcon } from "@radix-ui/react-icons";
import { LabeledSlider, SwitchRow } from "../widgets";
import type { OverlayStyle } from "./overlay";

/** Choices for the time after the video time, in s: by the second up to 30 s, then by 10 s. */
const AFTER_STOPS = [...Array.from({ length: 30 }, (_, i) => i + 1), 40, 50, 60, 70, 80, 90, 100, 110, 120];

/**
 * The Graph section of the controls: whether the graph and the minimap show,
 * the graph's line width, machine line and time before and after the
 * playhead; in theater mode also the background over the video and moving
 * and resizing the graph there, else a hint on resizing it below the video.
 */
export function GraphSettings({ showGraph, setShowGraph, minimap, setMinimap, overlay, setOverlay, machineLine, setMachineLine, span, setSpan, theater, canArrange, onArrange, onReset }: {
  showGraph: boolean;
  setShowGraph: (on: boolean) => void;
  /** The minimap of the current layout, theater mode's or the one below the graph. */
  minimap: boolean;
  setMinimap: (on: boolean) => void;
  overlay: OverlayStyle;
  setOverlay: (overlay: OverlayStyle) => void;
  machineLine: boolean;
  setMachineLine: (on: boolean) => void;
  /** Time the graphs show before and after the video time, in ms. */
  span: { before: number; after: number };
  setSpan: (span: { before: number; after: number }) => void;
  theater: boolean;
  /** There is a graph over the video to move and resize. */
  canArrange: boolean;
  onArrange: () => void;
  /** Back to the default look, size and time span. */
  onReset: () => void;
}) {
  return (
    <>
      <SwitchRow label="Show graph" checked={showGraph} onCheckedChange={setShowGraph} />
      <SwitchRow label="Show minimap" checked={minimap} onCheckedChange={setMinimap} />
      {showGraph && (
        <>
          <LabeledSlider
            label="Line width"
            value={overlay.lineWidth}
            display={`${overlay.lineWidth} px`}
            min={1}
            max={8}
            step={0.5}
            onChange={(lineWidth) => setOverlay({ ...overlay, lineWidth })}
          />
          <SwitchRow label="Show machine line" checked={machineLine} onCheckedChange={setMachineLine} />
          <LabeledSlider
            label="Before playhead"
            value={span.before}
            display={`${span.before / 1000} s`}
            min={0}
            max={10000}
            step={1000}
            onChange={(before) => setSpan({ ...span, before })}
          />
          <LabeledSlider
            label="After playhead"
            value={Math.max(AFTER_STOPS.findIndex((s) => s * 1000 >= span.after), 0)}
            display={`${span.after / 1000} s`}
            min={0}
            max={AFTER_STOPS.length - 1}
            step={1}
            onChange={(i) => setSpan({ ...span, after: AFTER_STOPS[i] * 1000 })}
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
                onChange={(background) => setOverlay({ ...overlay, background })}
              />
              <Button variant="soft" disabled={!canArrange} onClick={onArrange}>
                <MoveIcon /> Move and resize
              </Button>
            </>
          ) : (
            <Text size="1" color="gray">Drag the top edge of the graph to change its height.</Text>
          )}
          <Button variant="soft" color="gray" onClick={onReset}>
            Reset
          </Button>
        </>
      )}
    </>
  );
}
