import type { PointerEvent, ReactNode, RefObject } from "react";
import { Box, Button } from "@radix-ui/themes";
import { CheckIcon } from "@radix-ui/react-icons";
import { capturePointer } from "../drag";
import { dragAxis, handleStyle, OVERLAY_MIN_HEIGHT, OVERLAY_MIN_WIDTH, RESIZE_HANDLES, type OverlayStyle } from "./overlay";

/**
 * The graph over the video in theater mode, placed by `overlay` in the video
 * area `stage`. While arranging, drag the graph to move it and its handles to
 * resize it; otherwise clicks go through to the video. Done sits in its
 * middle, clear of the handles.
 */
export function TheaterGraph({ stage: stageRef, overlay, setOverlay, arranging, onDone, children }: {
  stage: RefObject<HTMLDivElement | null>;
  overlay: OverlayStyle;
  setOverlay: (overlay: OverlayStyle) => void;
  arranging: boolean;
  onDone: () => void;
  /** The graph. */
  children: ReactNode;
}) {
  /**
   * Drag `edges` (some of "nsew") of the graph over the video with the pointer;
   * all four move it. It stays inside the video area and at least the minimum size.
   */
  const dragOverlay = (e: PointerEvent<HTMLElement>, edges: string) => {
    e.preventDefault();
    e.stopPropagation();
    const stage = stageRef.current!.getBoundingClientRect();
    const start = overlay;
    const [startX, startY] = [e.clientX, e.clientY];
    const move = (m: globalThis.PointerEvent) => {
      const dx = (m.clientX - startX) / stage.width;
      const dy = (m.clientY - startY) / stage.height;
      const [x, width] = dragAxis(start.x, start.width, dx, edges.includes("w"), edges.includes("e"), OVERLAY_MIN_WIDTH / stage.width);
      const [y, height] = dragAxis(start.y, start.height, dy, edges.includes("n"), edges.includes("s"), OVERLAY_MIN_HEIGHT / stage.height);
      setOverlay({ ...start, x, y, width, height });
    };
    capturePointer(e.currentTarget, e.pointerId, move);
  };
  return (
    <Box
      position="absolute"
      style={{
        left: `${overlay.x * 100}%`,
        top: `${overlay.y * 100}%`,
        width: `${overlay.width * 100}%`,
        height: `${overlay.height * 100}%`,
        ...(arranging
          ? { cursor: "move", borderRadius: 6, outline: "2px dashed white", boxShadow: "0 0 0 3px rgba(0,0,0,0.5)" }
          : { pointerEvents: "none" }),
      }}
      onPointerDown={(e) => dragOverlay(e, "nsew")}
    >
      {children}
      {arranging &&
        RESIZE_HANDLES.map((h) => <Box key={h} title="Drag to resize" style={handleStyle(h)} onPointerDown={(e) => dragOverlay(e, h)} />)}
      {/* Stops the pointer here, so pressing Done does not start a drag. */}
      {arranging && (
        <Box
          position="absolute"
          style={{ left: "50%", top: "50%", translate: "-50% -50%", cursor: "auto" }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <Button onClick={onDone}>
            <CheckIcon /> Done
          </Button>
        </Box>
      )}
    </Box>
  );
}
