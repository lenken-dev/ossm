import { useEffect, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import { silence } from "./playback";

/**
 * The silent clock: silent audio `ms` long, the media without a video, at
 * script speed `speed`; none while `ms` is `null`. `onDrop` ends what follows
 * it before it unmounts.
 */
export function useSilentClock({ ms, speed, videoRef, onDrop }: {
  ms: number | null;
  speed: number;
  videoRef: RefObject<HTMLMediaElement | null>;
  onDrop: (reason: string) => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (ms == null) return;
    const url = URL.createObjectURL(silence(ms));
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [ms]);
  /** Script time in ms to put the clock back at once it reloads at a new length. */
  const resume = useRef<number | null>(null);
  return {
    url,
    /** Before the silent clock unmounts: its events no longer reach React then. */
    drop: (reason: string) => {
      if (url) onDrop(reason);
    },
    /** Before the speed changes: the clock's length follows it; keep the playhead at the same script time. */
    hold: () => {
      if (url) resume.current ??= (videoRef.current?.currentTime ?? 0) * 1000 * speed;
    },
    /** The clock's `onLoadedMetadata`. */
    onLoadedMetadata: (e: SyntheticEvent<HTMLMediaElement>) => {
      if (resume.current === null) return;
      e.currentTarget.currentTime = resume.current / 1000 / speed;
      resume.current = null;
    },
  };
}
