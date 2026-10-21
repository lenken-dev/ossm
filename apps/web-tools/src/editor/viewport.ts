import { useEffect, useState, type Dispatch, type PointerEvent, type RefObject, type SetStateAction } from "react";
import { clamp } from "../funscript/model";
import { capturePointer } from "../drag";

/** Height of the time axis below the graph and space above and below the points, in px. */
export const AXIS = 20;
export const PAD = 10;

/** Width of the graph's left and right edges where a drag scrolls it, in px, and its fastest scroll, in visible times per second. */
const EDGE = 30;
const EDGE_SPEED = 1.5;

/** The graph's size and its mapping between script time and depth and px, with the drags that follow the pointer across it. */
export interface Viewport {
  width: number;
  height: number;
  /** The graph's height above the time axis. */
  plotHeight: number;
  x(at: number): number;
  y(pos: number): number;
  /** The script time and position under the pointer. */
  pointerAt(e: { clientX: number; clientY: number }): { at: number; pos: number };
  /**
   * Follow a drag from `e` on `target` with `move`, then `end`. Held at the
   * graph's left or right edge, or past it, the graph scrolls that way, faster
   * the further out, and `move` follows; only once the drag has been away from
   * the edges, so a press near one does not scroll, and while `scrolls` allows
   * it in that direction (1 right, -1 left) with the pointer at `m`.
   */
  track(
    target: Element,
    e: PointerEvent<Element>,
    move: (m: globalThis.PointerEvent) => void,
    end?: () => void,
    scrolls?: (dir: number, m: globalThis.PointerEvent) => boolean,
  ): void;
}

/** The graph's viewport: `boxRef`'s measured size, the visible time `viewRef` holds, which a drag at an edge scrolls with `setView`. */
export function useViewport(
  boxRef: RefObject<HTMLDivElement | null>,
  viewRef: RefObject<{ from: number; span: number }>,
  setView: Dispatch<SetStateAction<{ from: number; span: number }>>,
): Viewport {
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(boxRef.current!);
    return () => observer.disconnect();
  }, []);
  // As rendered: the page puts its view in the ref before calling this.
  const view = viewRef.current;
  const plotHeight = height - AXIS;
  const x = (at: number) => ((at - view.from) / view.span) * width;
  const y = (pos: number) => PAD + (1 - pos / 100) * (plotHeight - 2 * PAD);
  const pointerAt = (e: { clientX: number; clientY: number }) => {
    const rect = boxRef.current!.getBoundingClientRect();
    const { from, span } = viewRef.current;
    return {
      at: Math.round(from + ((e.clientX - rect.left) / width) * span),
      pos: Math.round(clamp(100 - ((e.clientY - rect.top - PAD) / (plotHeight - 2 * PAD)) * 100, 0, 100)),
    };
  };

  const track = (
    target: Element,
    e: PointerEvent<Element>,
    move: (m: globalThis.PointerEvent) => void,
    end?: () => void,
    scrolls?: (dir: number, m: globalThis.PointerEvent) => boolean,
  ) => {
    let last: globalThis.PointerEvent | null = null;
    let armed = false;
    let before = performance.now();
    const pushed = (m: { clientX: number }) => {
      const rect = boxRef.current!.getBoundingClientRect();
      const px = m.clientX - rect.left;
      return clamp(px < EDGE ? (px - EDGE) / EDGE : px > rect.width - EDGE ? (px - rect.width + EDGE) / EDGE : 0, -1, 1);
    };
    let frame = requestAnimationFrame(function scroll(now) {
      const v = viewRef.current;
      const push = last && armed ? pushed(last) : 0;
      const from = Math.max(v.from + (push && (scrolls?.(Math.sign(push), last!) ?? true) ? push : 0) * EDGE_SPEED * v.span * ((now - before) / 1000), 0);
      before = now;
      if (from !== v.from) {
        setView((viewRef.current = { ...v, from }));
        move(last!);
      }
      frame = requestAnimationFrame(scroll);
    });
    const moved = (m: globalThis.PointerEvent) => {
      last = m;
      armed ||= !pushed(m);
      move(m);
    };
    capturePointer(target, e.pointerId, moved, () => {
      cancelAnimationFrame(frame);
      end?.();
    });
  };

  return { width, height, plotHeight, x, y, pointerAt, track };
}
