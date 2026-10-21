import type { PointerEvent as ReactPointerEvent } from "react";

/** Follow pointer `pointerId` on `target` with `move` until it loses the pointer's capture, then `end`. */
export function capturePointer(target: Element, pointerId: number, move: (m: PointerEvent) => void, end?: () => void) {
  target.setPointerCapture(pointerId);
  target.addEventListener("pointermove", move as EventListener);
  target.addEventListener("lostpointercapture", () => {
    target.removeEventListener("pointermove", move as EventListener);
    end?.();
  }, { once: true });
}

/** Drag the bottom of something `start` px high to resize it, or its top if `top`, from `min` px to 70% of the window. */
export const dragHeight = (e: ReactPointerEvent<HTMLElement>, start: number, set: (h: number) => void, min: number, top = false) => {
  e.preventDefault();
  const startY = e.clientY;
  const move = (m: PointerEvent) =>
    set(Math.round(Math.min(Math.max(start + (top ? startY - m.clientY : m.clientY - startY), min), window.innerHeight * 0.7)));
  capturePointer(e.currentTarget, e.pointerId, move);
};
