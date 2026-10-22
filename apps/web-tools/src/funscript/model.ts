export interface Action {
  /** Time in ms. */
  at: number;
  /** 0 (deep end) to 100 (shallow end). */
  pos: number;
}

/** The script's line colour, in the player's and the editor's graphs. */
export const LINE_COLOR = "#ec4899";
/** The machine line's colour, beside the script's line in the player's graph. */
export const MACHINE_COLOR = "#22d3ee";
/** `v` kept within `lo`–`hi`. */
export const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** `set` with `item` in it if it wasn't, else without it. */
export const toggled = <T,>(item: T) => (set: Set<T>) => {
  const next = new Set(set);
  if (!next.delete(item)) next.add(item);
  return next;
};
/** The speed from `a` to `b`, in depth per second. */
export const speed = (a: Action, b: Action) => (Math.abs(b.pos - a.pos) / (b.at - a.at)) * 1000;
/** `n` points, in words: "1 point", "2 points". */
export const points = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;

/** Stats of picked points, sorted; speeds only over moves between picked neighbours, the average their travel over their time. */
export function stats(actions: Action[], picked: number[]) {
  let low = Infinity, high = -Infinity, top = 0, travel = 0, time = 0;
  picked.forEach((i, k) => {
    const a = actions[i];
    low = Math.min(low, a.pos);
    high = Math.max(high, a.pos);
    if (k && picked[k - 1] === i - 1) {
      top = Math.max(top, speed(actions[i - 1], a));
      travel += Math.abs(a.pos - actions[i - 1].pos);
      time += a.at - actions[i - 1].at;
    }
  });
  return { top, average: time ? (travel / time) * 1000 : 0, low, high, duration: actions[picked[picked.length - 1]].at - actions[picked[0]].at };
}
