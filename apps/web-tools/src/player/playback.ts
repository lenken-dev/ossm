import type { readMarkers } from "../funscript/markers";
import type { Ossm, OssmState } from "./ble";

/** A script's chapters and bookmarks, in script ms. */
export type Markers = ReturnType<typeof readMarkers>;

/** Send loop period in ms. */
export const TICK_MS = 10;

/** Speed limit of the funscript speed sliders until the user changes it, in percent. */
export const DEFAULT_SPEED_LIMIT = 5;

/** The media's time moves on: it plays and is not seeking or waiting for data. */
export const advancing = (media: HTMLMediaElement) =>
  !media.paused && !media.seeking && media.readyState >= media.HAVE_FUTURE_DATA && media.playbackRate > 0;

/** The script playhead, in script ms. */
export interface Playhead {
  get(): number;
  set(ms: number): void;
}

export const isHomed = (state: OssmState | null) => state?.state === "ready" || state?.state === "streaming";

/** Why the machine does not follow the funscript, or `null` when it does. */
export function blockReason(
  ossm: Ossm | null,
  state: OssmState | null,
  configured: boolean,
  setupOpen: boolean,
): string | null {
  if (!ossm || !state) return "Connect the OSSM";
  if (ossm.lookahead === 0) return "This firmware cannot stream";
  if (state.state === "homing") return "Homing…";
  if (!isHomed(state)) return "Home the machine";
  if (setupOpen) return "Setting up";
  if (!configured) return "Set depth and stroke";
  if (state.speed <= 0) return "Raise the speed";
  return null;
}

/**
 * A silent WAV covering `ms` of script, the playback clock when there is no
 * video, so playback, seeking and the stream work exactly as with one.
 */
// 3 kB per second (~11 MB per hour of script); write a clock if that ever hurts.
export function silence(ms: number): Blob {
  const rate = 3000; // Chrome's lowest sample rate
  const samples = Math.ceil((ms / 1000 + 1) * rate);
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset: number, s: string) => [...s].forEach((c, i) => header.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  header.setUint32(4, 36 + samples, true);
  text(8, "WAVEfmt ");
  header.setUint32(16, 16, true); // fmt chunk size
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, rate, true);
  header.setUint32(28, rate, true); // bytes per second
  header.setUint16(32, 1, true); // bytes per frame
  header.setUint16(34, 8, true); // bits per sample
  text(36, "data");
  header.setUint32(40, samples, true);
  return new Blob([header, new Uint8Array(samples).fill(128)], { type: "audio/wav" });
}
