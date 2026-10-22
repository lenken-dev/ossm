import { utcTicks } from "d3";

/** Time axis ticks on d3's time steps, about `count` of them. */
export function timeTicks(min: number, max: number, count = 8): number[] {
  return utcTicks(new Date(min * 1000), new Date(max * 1000), count).map((d) => d.getTime() / 1000);
}

/** Format script time as `12.5s` or `3:07.5`. */
export function formatScriptTime(secs: number, decimals = 1): string {
  const factor = 10 ** decimals;
  const total = Math.round(Math.abs(secs) * factor) / factor;
  const sign = secs < 0 && total > 0 ? "-" : "";
  const minutes = Math.floor(total / 60);
  const rest = (total - minutes * 60).toFixed(decimals);
  if (minutes === 0) return `${sign}${rest}s`;
  return `${sign}${minutes}:${rest.padStart(decimals > 0 ? 3 + decimals : 2, "0")}`;
}

/** Axis tick label: whole seconds without decimals. */
export function formatTimeTick(secs: number): string {
  const whole = Math.abs(secs - Math.round(secs)) < 1e-6;
  return formatScriptTime(secs, whole ? 0 : 1);
}
