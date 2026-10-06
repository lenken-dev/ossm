import { bisectRight } from "d3";
import type { Funscript } from "../StreamPanel";

/** A stream point to send, with what its log line needs. */
export interface OutgoingPoint {
  /** Action index. */
  index: number;
  /** 0 (deep) to 100 (shallow), after Reverse. */
  position: number;
  /** ms */
  duration: number;
  /** The action's script time, ms. */
  at: number;
  /** Media time (including the sync offset) at sending, ms. */
  media: number;
  /** Sent points beyond the current target, including this one. */
  ahead: number;
  /** The first point of a stream, timed from the media time. */
  first: boolean;
  /** How long its predecessor was already due, ms; 0 when on time. */
  lateBy: number;
}

/**
 * Decides which funscript actions to stream and when, from the media time
 * alone. Holds only which actions the open stream has sent; no React, no BLE.
 */
export class FunscriptStream {
  /** Index of the next action to send; `null` while no stream is open. */
  private next: number | null = null;

  get open() {
    return this.next !== null;
  }

  /** Close the stream. Returns whether one was open, i.e. whether `stream:end` must be sent. */
  end() {
    const wasOpen = this.open;
    this.next = null;
    return wasOpen;
  }

  /**
   * The points to send at media time `media` (ms, `currentTime * 1000 +
   * offset`): without an open stream, the target (first action after
   * `media`) timed from `media`, which opens one; then every unsent action up
   * to `lookahead` beyond the target, timed from its predecessor. Durations
   * are script times divided by `rate`.
   */
  tick(script: Funscript, media: number, rate: number, reverse: boolean, lookahead: number): OutgoingPoint[] {
    const { at, pos } = script;
    const last = at.length - 1;
    const target = bisectRight(at, media);
    const point = (i: number, duration: number, first: boolean, lateBy: number): OutgoingPoint => ({
      index: i,
      position: reverse ? 100 - pos[i] : pos[i],
      duration: Math.round(duration / rate),
      at: at[i],
      media,
      ahead: i - target,
      first,
      lateBy,
    });

    const points: OutgoingPoint[] = [];
    if (this.next === null) {
      // After the last action nothing is sent; the machine rests at its last point.
      if (target > last) return points;
      points.push(point(target, at[target] - media, true, 0));
      this.next = target + 1;
    }
    for (const until = Math.min(target + lookahead, last); this.next <= until; this.next++) {
      const i = this.next;
      points.push(point(i, at[i] - at[i - 1], false, Math.max(0, media - at[i - 1])));
    }
    return points;
  }
}

/** Simplify keeps a point inside a same-direction run once this long after the last kept one, in ms. */
const SIMPLIFY_GAP_MS = 500;

/**
 * The script without the points inside a run in one direction: it keeps the
 * ends, every change of direction (including the start and end of a hold),
 * and points at least `SIMPLIFY_GAP_MS` after the last kept one, so slow
 * runs keep their changes of speed.
 */
export function simplify(script: Funscript): Funscript {
  const { at, pos } = script;
  const last = at.length - 1;
  const keep = [0];
  for (let i = 1; i < last; i++) {
    const turns = Math.sign(pos[i] - pos[i - 1]) !== Math.sign(pos[i + 1] - pos[i]);
    if (turns || at[i] - at[keep[keep.length - 1]] >= SIMPLIFY_GAP_MS) keep.push(i);
  }
  keep.push(last);
  return {
    name: script.name,
    at: Uint32Array.from(keep, (i) => at[i]),
    pos: Float64Array.from(keep, (i) => pos[i]),
  };
}
