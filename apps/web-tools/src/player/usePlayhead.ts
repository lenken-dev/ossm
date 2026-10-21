import { useRef, type RefObject } from "react";
import { advancing, type Playhead } from "./playback";

/**
 * The script playhead, in script ms: with `synced`, the media's time at
 * `scriptSpeed`; otherwise the script's own clock, which only plays and
 * pauses with the media and stays within the script's `scriptEnd`.
 */
export function usePlayhead({ videoRef, synced, scriptSpeed, scriptEnd }: {
  videoRef: RefObject<HTMLMediaElement | null>;
  synced: boolean;
  scriptSpeed: number;
  scriptEnd: number;
}) {
  /**
   * The script's own clock while not synced: script time `at` in ms, moving
   * on at `rate` script ms per ms from `since` (`performance.now()`) while
   * the media advances, else `since` is `null`.
   */
  const clock = useRef<{ at: number; since: number | null; rate: number }>({ at: 0, since: null, rate: 1 });
  const clockTime = () => {
    const { at, since, rate } = clock.current;
    return since === null ? at : at + (performance.now() - since) * rate;
  };
  /** Restart the clock from now, running whenever the media advances. */
  const retimeClock = () => {
    const media = videoRef.current;
    clock.current = {
      at: clockTime(),
      since: media && advancing(media) ? performance.now() : null,
      rate: (media?.playbackRate ?? 1) * scriptSpeed,
    };
  };
  const playhead = useRef<Playhead>(null!);
  playhead.current = synced ? {
    get: () => (videoRef.current?.currentTime ?? 0) * 1000 * scriptSpeed,
    set: (ms) => {
      const media = videoRef.current;
      if (media) media.currentTime = Math.min(Math.max(ms / scriptSpeed / 1000, 0), media.duration || 0);
    },
  } : {
    get: clockTime,
    set: (ms) => {
      clock.current.at = Math.min(Math.max(ms, 0), scriptEnd);
      if (clock.current.since !== null) clock.current.since = performance.now();
    },
  };
  /** Stop the script's own clock at script time `at` in ms. */
  const restartClock = (at: number) => void (clock.current = { at, since: null, rate: 1 });
  return { playhead, retimeClock, restartClock };
}
