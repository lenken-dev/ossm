import { useEffect, useRef, useState, type RefObject } from "react";
import type { Funscript } from "../funscript/file";
import type { Ossm, OssmState } from "./ble";
import { advancing, blockReason, TICK_MS, type Playhead } from "./playback";
import { FunscriptStream } from "./stream";

/** Longest time between `stream:sync:` stamps while a timed stream is open, in ms. */
const SYNC_INTERVAL_MS = 1000;

/**
 * Streams `script` to `ossm` in funscript mode (`active`) while the video
 * plays, `offset` ms ahead of the `playhead` at script speed `speed`, once
 * depth and stroke are set up; the setup holds the speed to `speedLimit`.
 */
export function useScriptStream({ active, ossm, state, videoRef, paused, script, playhead, offset, speed, reverse, speedLimit }: {
  active: boolean;
  ossm: Ossm | null;
  state: OssmState | null;
  videoRef: RefObject<HTMLMediaElement | null>;
  paused: boolean;
  script: Funscript | null;
  playhead: RefObject<Playhead>;
  offset: number;
  speed: number;
  reverse: boolean;
  speedLimit: number;
}) {
  /** Script time in ms the machine plays at, `offset` ahead of the playhead. */
  const streamTime = () => playhead.current.get() + offset * speed;
  const stream = useRef(new FunscriptStream());
  /** Depth and stroke set since connecting or entering funscript mode. */
  const [configured, setConfigured] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const blocked = blockReason(ossm, state, configured, setupOpen);

  /** Send `stream:end` if a stream is open. */
  const endStream = (reason: string) => {
    if (!stream.current.end()) return;
    void ossm?.command("stream:end", `(${reason}, media=${Math.round(streamTime())})`);
  };

  // Entering funscript mode (or connecting in it) sends `go:streaming`.
  useEffect(() => {
    if (!active || !ossm || ossm.lookahead === 0) return;
    void ossm.command("go:streaming");
  }, [active, ossm]);

  // Depth and stroke may have changed elsewhere (pattern mode, another remote).
  useEffect(() => {
    setConfigured(false);
    setSetupOpen(false);
  }, [ossm, active]);

  // The setup's speed limit also holds for a speed raised while playing or a lowered limit.
  useEffect(() => {
    if (setupOpen && ossm && state && state.speed > speedLimit) void ossm.command(`set:speed:${speedLimit}`);
  }, [setupOpen, ossm, state, speedLimit]);

  // A disconnect closes the stream (nothing to send it to) and pauses the video.
  useEffect(() => {
    if (!ossm) return;
    const onDisconnect = () => {
      stream.current.end();
      videoRef.current?.pause();
    };
    ossm.addEventListener("disconnect", onDisconnect);
    return () => ossm.removeEventListener("disconnect", onDisconnect);
  }, [ossm]);

  // The video plays on without the machine; the machine stops once it is blocked.
  useEffect(() => {
    if (active && blocked) endStream(blocked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, blocked]);

  // The send loop. It keeps running, throttled, in background tabs. A stream
  // starts on the first tick while the video actually plays, so after an end
  // that does not stop playback (rate, script) the next one starts
  // right away.
  useEffect(() => {
    if (!active || paused || blocked || !ossm || !script) return;
    /** When the last `stream:sync:` was queued (`performance.now()`). */
    let synced = -Infinity;
    const id = setInterval(() => {
      const video = videoRef.current;
      if (!video || !advancing(video)) return;
      const opening = !stream.current.open;
      const wall = performance.now();
      const points = stream.current.tick(script, streamTime(), wall, video.playbackRate * speed, reverse, ossm.lookahead);
      if (!ossm.timebase) {
        for (const p of points) void ossm.streamPoint(p.position, p.duration);
        return;
      }
      // Before each stream's first point, then while it is open.
      if (stream.current.open && (opening || wall - synced >= SYNC_INTERVAL_MS)) {
        void ossm.streamSync();
        synced = wall;
      }
      for (const p of points) void ossm.streamPointAt(p.position, p.at);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active, paused, blocked, ossm, script, offset, speed, reverse]);

  return {
    configured,
    setupOpen,
    /** Why the machine does not follow the script, or `null`. */
    blocked,
    endStream,
    /** Pause the video and the machine, then ask for depth and stroke. */
    openSetup: () => {
      videoRef.current?.pause();
      endStream("setup");
      setSetupOpen(true);
    },
    closeSetup: () => setSetupOpen(false),
    /** Depth and stroke are set. */
    setUp: () => setConfigured(true),
  };
}
