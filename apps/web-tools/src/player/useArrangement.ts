import { useEffect, useRef, useState, type PointerEvent } from "react";
import { dragHeight } from "../drag";

/** Size the popout window opens at, in px. */
const POPOUT_SIZE = { width: 320, height: 640 };
/** Smallest height of the preview graph below the video, in px. */
const PREVIEW_MIN_HEIGHT = 60;

/**
 * Where the player's parts go: theater mode, which needs `canTheater`; the
 * controls pane in it; the popout window; the graph over the video; and the
 * `height` of the graph below it, set with `onHeight`.
 */
export function useArrangement({ canTheater, height, onHeight }: {
  canTheater: boolean;
  height: number;
  onHeight: (height: number) => void;
}) {
  const [theater, setTheater] = useState(false);
  const [showControls, setShowControls] = useState(true);
  /** The always-on-top window the controls float in, over other tabs and applications. */
  const [popout, setPopout] = useState<Window | null>(null);
  /** Moving and resizing the graph; otherwise clicks go through it to the video. */
  const [arranging, setArranging] = useState(false);
  /** The video area, which the graph's position and size are fractions of. */
  const stageRef = useRef<HTMLDivElement>(null);

  const openPopout = async () => {
    const win = await window.documentPictureInPicture!.requestWindow(POPOUT_SIZE);
    // The page's styles: <style>s in dev, <link>s in builds.
    for (const sheet of document.styleSheets) {
      win.document.head.append(sheet.href
        ? Object.assign(win.document.createElement("link"), { rel: "stylesheet", href: sheet.href })
        : Object.assign(win.document.createElement("style"), { textContent: sheet.ownerNode?.textContent ?? "" }));
    }
    win.document.body.style.margin = "0";
    win.addEventListener("pagehide", () => setPopout(null), { once: true });
    setPopout(win);
  };
  // Leaving the page takes the controls with it.
  useEffect(() => () => popout?.close(), [popout]);

  return {
    /** Theater mode needs a video and a wide screen; closing the video leaves theater mode. */
    inTheater: theater && canTheater,
    enterTheater: () => setTheater(true),
    leaveTheater: () => setTheater(false),
    showControls,
    toggleControls: () => setShowControls(!showControls),
    popout,
    openPopout,
    arranging,
    arrange: () => setArranging(true),
    doneArranging: () => setArranging(false),
    stageRef,
    /** Drag the top edge of the graph below the video to set its height; at most most of the window. */
    dragGraphHeight: (e: PointerEvent<HTMLElement>) => dragHeight(e, height, onHeight, PREVIEW_MIN_HEIGHT, true),
  };
}
