import { useRef, type Dispatch, type PointerEvent, type RefObject, type SetStateAction } from "react";
import { clamp } from "../funscript/model";
import { capturePointer } from "../drag";
import { useElementSize } from "../hooks/useElementSize";

/** Height of the time axis below the graph and space above and below the points, in px. */
export const AXIS = 20;
export const PAD = 10;
/** Where the playhead stays in view while the video plays, as a fraction of the visible time. */
export const FOLLOW_AT = 0.2;

/** The visible time: where it starts and how long it is, in ms. */
export interface View {
  from: number;
  span: number;
}

/** The view `v` moved to show the time `t` ms where the playhead stays while the video plays, from 0 on. */
export const bringIntoView = (v: View, t: number): View => ({ ...v, from: Math.max(t - v.span * FOLLOW_AT, 0) });

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
  /** Whether the time from `from` to `to` is in view, to draw only what is there. */
  inView(from: number, to: number): boolean;
  /** The script time and position under the pointer, in the latest view. */
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

/** The graph's viewport: `boxRef`'s measured size and the visible time, `view`, which a drag at an edge scrolls with `setView`. */
export function useViewport(
  boxRef: RefObject<HTMLDivElement | null>,
  view: View,
  setView: Dispatch<SetStateAction<View>>,
): Viewport {
  const { width, height } = useElementSize(boxRef);
  /** The latest view, for drags, which read it between renders as they scroll it; `x` and `y` draw the view as rendered. */
  const viewRef = useRef(view);
  viewRef.current = view;
  const plotHeight = height - AXIS;
  const x = (at: number) => ((at - view.from) / view.span) * width;
  const y = (pos: number) => PAD + (1 - pos / 100) * (plotHeight - 2 * PAD);
  const inView = (from: number, to: number) => to >= view.from && from <= view.from + view.span;
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

  return { width, height, plotHeight, x, y, inView, pointerAt, track };
}
