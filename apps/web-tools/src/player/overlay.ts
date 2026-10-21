import type { CSSProperties } from "react";
import { clamp } from "../funscript/model";

/** Place and look of the graph over the video in theater mode. */
export interface OverlayStyle {
  /** Position and size, in fractions of the video area. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Also the line width of the graph below the video. */
  lineWidth: number;
  /** Opacity of the black background, in percent. */
  background: number;
}
/** Full width, ending above Chrome's video controls in most window sizes. */
export const DEFAULT_OVERLAY: OverlayStyle = { x: 0, y: 0.7, width: 1, height: 0.18, lineWidth: 2, background: 0 };

/** Smallest graph over the video while resizing, in px; room for the corner handles. */
export const OVERLAY_MIN_WIDTH = 120;
export const OVERLAY_MIN_HEIGHT = 60;

/** Resize handles of the graph over the video, by the corner they move. */
export const RESIZE_HANDLES = ["nw", "ne", "se", "sw"];
export const CORNER_HANDLE = 24;

/** Where a resize handle sits and how it looks: an L in its corner. */
export function handleStyle(handle: string): CSSProperties {
  const border = "4px solid white";
  return {
    position: "absolute",
    width: CORNER_HANDLE,
    height: CORNER_HANDLE,
    borderRadius: 6,
    cursor: `${handle}-resize`,
    filter: "drop-shadow(0 0 1px black) drop-shadow(0 0 2px black)",
    ...(handle.includes("n") ? { top: 0, borderTop: border } : { bottom: 0, borderBottom: border }),
    ...(handle.includes("w") ? { left: 0, borderLeft: border } : { right: 0, borderRight: border }),
  };
}

/**
 * One axis of dragging the graph over the video: its start and size, in
 * fractions of the video area, after its start and/or end edge moved by
 * `delta`. Moving both edges moves the graph.
 */
export function dragAxis(pos: number, size: number, delta: number, startEdge: boolean, endEdge: boolean, min: number): [number, number] {
  if (startEdge && endEdge) return [clamp(pos + delta, 0, 1 - size), size];
  if (startEdge) {
    const moved = clamp(pos + delta, 0, pos + size - min);
    return [moved, pos + size - moved];
  }
  if (endEdge) return [pos, clamp(size + delta, min, 1 - pos)];
  return [pos, size];
}
