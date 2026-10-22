import { Flex, Text } from "@radix-ui/themes";
import { formatScriptTime, formatTimeTick, timeTicks } from "../funscript/time";
import { clamp, LINE_COLOR, type Action } from "../funscript/model";
import type { Bookmark, Chapter } from "../funscript/markers";
import { isInstance, regionName, type Region } from "./model";

/** Height of a small graph's time axis, in px. */
const PREVIEW_AXIS = 12;
/** Unchanged points shown on each side of a change in a diff, the one next to it included. */
const DIFF_CONTEXT = 3;
/** Past this many differences, a diff shows everything from the first to the last as changed. */
const DIFF_MAX = 500;
/** Width of the break where a diff leaves out unchanged points, in px. */
const DIFF_BREAK = 8;

/**
 * A stretch of a small graph, drawn right after the one before it whatever its
 * times: points of one script, with the unchanged points on each side of a
 * change. Moved points are drawn over where they were, the `old` points.
 */
interface Piece {
  kind: "plain" | "same" | "removed" | "added" | "moved" | "break";
  points: Action[];
  from?: Action;
  to?: Action;
  old?: Action[];
}

/** How each kind of piece draws: its line and points, whether dashed, and the band behind its points. */
const PIECE_STYLES: Record<Piece["kind"], { color: string; dashed?: boolean; band?: string }> = {
  plain: { color: LINE_COLOR },
  same: { color: "var(--gray-8)" },
  removed: { color: "var(--red-9)", dashed: true, band: "var(--red-a3)" },
  added: { color: "var(--green-9)", band: "var(--green-a3)" },
  moved: { color: "var(--gray-8)" },
  break: { color: "var(--gray-8)", dashed: true },
};

/**
 * Myers' diff of `a` and `b`: the index pairs of their longest common
 * subsequence, in order; null past `max` differences.
 */
function common(a: string[], b: string[], max: number): [number, number][] | null {
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  /** `v` before each step, to go back along the path. */
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) [x, y] = [x + 1, y + 1];
      v[off + k] = x;
      if (x < a.length || y < b.length) continue;
      const pairs: [number, number][] = [];
      for (let e = d; e > 0; e--) {
        const [w, k] = [trace[e], x - y];
        const prev = k === -e || (k !== e && w[off + k - 1] < w[off + k + 1]) ? k + 1 : k - 1;
        const [px, py] = [w[off + prev], w[off + prev] - prev];
        while (x > px && y > py) pairs.push([--x, --y]);
        [x, y] = [px, py];
      }
      while (x > 0 && y > 0) pairs.push([--x, --y]);
      return pairs.reverse();
    }
  }
  return null;
}

/**
 * A diff of two scripts' points like git's, as pieces of a small graph: each
 * change shows the points removed, then the points added, between a few
 * unchanged points; more unchanged points than that are left out. Points match
 * by depth and time since the point before, so a stretch that only shifted in
 * time stays unchanged. Points that all moved alike, all others unchanged, show
 * moved instead, over where they were.
 */
export function diffPieces(before: Action[], after: Action[]): Piece[] {
  const pieces: Piece[] = [];
  const same = (from: number, to: number) => from < to && pieces.push({ kind: "same", points: after.slice(from, to) });
  if (before.length === after.length) {
    const changed = [...before.keys()].filter((i) => before[i].at !== after[i].at || before[i].pos !== after[i].pos);
    const [i0, i1] = [changed[0], changed[changed.length - 1]];
    const moved = (i: number) => [after[i].at - before[i].at, after[i].pos - before[i].pos].join();
    if (changed.length && changed.every((i) => moved(i) === moved(i0))) {
      same(Math.max(i0 - DIFF_CONTEXT, 0), i0);
      pieces.push({ kind: "moved", points: after.slice(i0, i1 + 1), old: before.slice(i0, i1 + 1), from: after[i0 - 1], to: after[i1 + 1] });
      same(i1 + 1, Math.min(i1 + 1 + DIFF_CONTEXT, after.length));
      return pieces;
    }
  }
  const key = (a: Action, i: number, all: Action[]) => `${a.at - (all[i - 1]?.at ?? 0)},${a.pos}`;
  const [kb, ka] = [before.map(key), after.map(key)];
  let start = 0;
  while (start < kb.length && start < ka.length && kb[start] === ka[start]) start++;
  let end = 0;
  while (end < kb.length - start && end < ka.length - start && kb[kb.length - 1 - end] === ka[ka.length - 1 - end]) end++;
  const pairs = common(kb.slice(start, kb.length - end), ka.slice(start, ka.length - end), DIFF_MAX) ?? [];
  /** The changes: the points before from `i0` to `i1` became the points after from `j0` to `j1`. */
  const hunks = [];
  let [i, j] = [start, start];
  for (const [pi, pj] of [...pairs.map(([a, b]) => [a + start, b + start]), [kb.length - end, ka.length - end]]) {
    let [i1, j1] = [pi, pj];
    // The point after an insert or delete only changed its time since the point before; it stays unchanged.
    // ponytail: also takes a replaced last point at the same depth as unchanged; compare the times past it if that misleads.
    while (i1 > i && j1 > j && before[i1 - 1].pos === after[j1 - 1].pos) [i1, j1] = [i1 - 1, j1 - 1];
    if (i1 > i || j1 > j) hunks.push({ i0: i, i1, j0: j, j1 });
    [i, j] = [pi + 1, pj + 1];
  }
  let shown = 0;
  hunks.forEach(({ i0, i1, j0, j1 }, h) => {
    if (h === 0) same(Math.max(j0 - DIFF_CONTEXT, 0), j0);
    else if (j0 - shown <= 2 * DIFF_CONTEXT) same(shown, j0);
    else {
      same(shown, shown + DIFF_CONTEXT);
      pieces.push({ kind: "break", points: [] });
      same(j0 - DIFF_CONTEXT, j0);
    }
    if (i1 > i0) pieces.push({ kind: "removed", points: before.slice(i0, i1), from: before[i0 - 1], to: before[i1] });
    if (j1 > j0) pieces.push({ kind: "added", points: after.slice(j0, j1), from: after[j0 - 1], to: after[j1] });
    shown = j1;
  });
  if (hunks.length) same(shown, Math.min(shown + DIFF_CONTEXT, after.length));
  return pieces;
}

/**
 * A small graph of `pieces` side by side, each as wide as its time, with
 * breaks in between; the time ticks show each piece's own times. `bands`,
 * times in the first piece's, show faintly behind, as regions do.
 */
export function PreviewGraph({ pieces, bands = [] }: { pieces: Piece[]; bands?: { from: number; to: number }[] }) {
  if (!pieces.length) return <Text size="1" color="gray">No changes</Text>;
  const [width, plotHeight, pad] = [200, 60, 4];
  /** Moved points draw like removed ones where they were and added ones where they went, at the same times. */
  const layers = pieces.flatMap((p, i) => p.kind === "moved" ? [{ ...p, kind: "removed" as const, points: p.old!, i }, { ...p, kind: "added" as const, i }] : [{ ...p, i }]);
  const lines = layers.map((p) => [p.from, ...p.points, p.to].filter((a) => a !== undefined));
  const ends = (l: Action[]) => (l.length ? [l[0].at, l[l.length - 1].at] : []);
  const ranges = pieces.map((_, i) => {
    const all = layers.flatMap((l, k) => (l.i === i ? ends(lines[k]) : []));
    return all.length ? [Math.min(...all), Math.max(...all)] : [0, 0];
  });
  const breaks = pieces.filter((p) => p.kind === "break").length;
  const scale = (width - 2 * pad - breaks * DIFF_BREAK) / (ranges.reduce((sum, [a, b]) => sum + b - a, 0) || 1);
  let left = pad;
  const xs = pieces.map((p, i) => {
    const [from, x0] = [ranges[i][0], left];
    left += p.kind === "break" ? DIFF_BREAK : (ranges[i][1] - from) * scale;
    return (at: number) => x0 + (at - from) * scale;
  });
  const y = (pos: number) => pad + (1 - pos / 100) * (plotHeight - 2 * pad);
  // Each piece's own ticks, about three across the graph, left out where they would crowd the one before.
  const ticks: { x: number; label: string }[] = [];
  pieces.forEach((p, i) => {
    if (p.kind === "break") return;
    const [a, b] = ranges[i];
    const t = timeTicks(a / 1000, b / 1000, Math.max(1, Math.round((3 * (b - a) * scale) / (width - 2 * pad))));
    // Enough decimals to tell the ticks apart: their steps are 1, 2 or 5 times a power of ten below a second.
    const decimals = t.length > 1 ? Math.max(0, -Math.floor(Math.log10(t[1] - t[0]) + 1e-9)) : 1;
    for (const s of t) {
      const x = xs[i](s * 1000);
      if (x - (ticks[ticks.length - 1]?.x ?? -Infinity) >= 40) ticks.push({ x, label: formatScriptTime(s, decimals) });
    }
  });
  const dots = layers.reduce((n, p) => n + p.points.length, 0) <= 200;
  return (
    <svg width={width} height={plotHeight + PREVIEW_AXIS} style={{ display: "block" }}>
      {bands.map((b, k) => {
        const [x0, x1] = [clamp(xs[0](b.from), 0, width), clamp(xs[0](b.to), 0, width)];
        return <rect key={`band${k}`} x={x0} width={Math.max(x1 - x0, 1)} height={plotHeight} style={{ fill: "var(--cyan-a3)" }} />;
      })}
      {layers.map(({ kind, points, i }, l) => {
        const band = PIECE_STYLES[kind].band;
        const [a, b] = [points[0], points[points.length - 1]];
        return band && a && <rect key={l} x={xs[i](a.at)} width={Math.max(xs[i](b.at) - xs[i](a.at), 1)} y={0} height={plotHeight} style={{ fill: band }} />;
      })}
      {[0, 50, 100].map((pos) => (
        <line key={pos} x1={0} x2={width} y1={y(pos)} y2={y(pos)} style={{ stroke: "var(--gray-a5)" }} />
      ))}
      {ticks.map(({ x, label }) => {
        // Kept inside the graph at its edges.
        const anchor = x < 20 ? "start" : x > width - 20 ? "end" : "middle";
        return (
          <g key={x}>
            <line x1={x} x2={x} y1={0} y2={plotHeight} style={{ stroke: "var(--gray-a4)" }} />
            <text x={x} y={plotHeight + PREVIEW_AXIS - 2} textAnchor={anchor} fontSize={9} style={{ fill: "var(--gray-11)" }}>
              {label}
            </text>
          </g>
        );
      })}
      {/* Each moved point joined to where it went. */}
      {dots && pieces.flatMap((p, i) => (p.old ?? []).map((a, k) => (
        <line key={`${i}-${k}`} x1={xs[i](a.at)} y1={y(a.pos)} x2={xs[i](p.points[k].at)} y2={y(p.points[k].pos)} strokeWidth={1} style={{ stroke: PIECE_STYLES.moved.color }} />
      )))}
      {layers.map(({ kind, i }, l) => {
        const { color, dashed } = PIECE_STYLES[kind];
        const stroke = { stroke: color, strokeWidth: 1.5, strokeDasharray: dashed ? "3 2" : undefined };
        if (kind === "break") return <line key={l} x1={xs[i](0) + DIFF_BREAK / 2} x2={xs[i](0) + DIFF_BREAK / 2} y1={0} y2={plotHeight} {...stroke} />;
        return <polyline key={l} points={lines[l].map((a) => `${xs[i](a.at)},${y(a.pos)}`).join(" ")} fill="none" {...stroke} />;
      })}
      {dots && layers.flatMap(({ kind, points, i }, l) => points.map((a, k) => kind === "removed"
        ? <path key={`${l}-${k}`} d={`M${xs[i](a.at) - 2.5},${y(a.pos) - 2.5} l5,5 m0,-5 l-5,5`} strokeWidth={1.5} style={{ stroke: PIECE_STYLES.removed.color }} />
        : <circle key={`${l}-${k}`} cx={xs[i](a.at)} cy={y(a.pos)} r={kind === "added" ? 2.5 : 2} style={{ fill: PIECE_STYLES[kind].color }} />))}
      {pieces.flatMap((p, i) => [p.from, p.to].map((a, k) => a && <circle key={`${i}~${k}`} cx={xs[i](a.at)} cy={y(a.pos)} r={2} style={{ fill: "var(--gray-9)" }} />))}
    </svg>
  );
}

/** Changes a lane diff lists, past which it says how many more. */
const MARKER_DIFF_LINES = 4;

/** A marker or region as a lane diff shows it: its object, what it is and is called, and its time, a range or a moment. */
interface LaneItem {
  of: object;
  kind: string;
  name: string;
  span: number[];
}
export const chapterItem = (c: Chapter): LaneItem => ({ of: c, kind: "chapter", name: c.name, span: [c.start, c.end] });
export const bookmarkItem = (b: Bookmark): LaneItem => ({ of: b, kind: "bookmark", name: b.name, span: [b.time] });
export const regionItem = (r: Region): LaneItem => ({ of: r, kind: isInstance(r) ? "snippet" : "region", name: isInstance(r) ? r.snippet.name : regionName(r), span: [r.from, r.to] });

/**
 * A diff of two scripts' markers or regions, like the points' one: a small
 * lane over the time they changed in, as they were in red and dashed, as they
 * are in green, unchanged ones in grey, each moved one joined to where it
 * went; then the changes in words. Each of `lists` is one kind's items before
 * and after; nothing when none changed.
 */
export function LanePreview({ lists }: { lists: [LaneItem[], LaneItem[]][] }) {
  // Edits keep the items they leave alone, so the changed ones are those only one side has.
  const only = (a: LaneItem[], b: LaneItem[]) => {
    const kept = new Set(b.map((m) => m.of));
    return a.filter((m) => !kept.has(m.of));
  };
  const changes = lists.flatMap(([a, b]) => {
    const [gone, come] = [only(a, b), only(b, a)];
    // As many on each side, as a move or rename leaves, they pair up in time order.
    if (gone.length === come.length) return gone.map((old, i) => ({ old, now: come[i] as LaneItem | undefined }));
    return [...gone.map((old) => ({ old, now: undefined })), ...come.map((now) => ({ old: undefined as LaneItem | undefined, now }))];
  });
  if (!changes.length) return null;
  const span = (m: LaneItem) => m.span;
  const times = changes.flatMap(({ old, now }) => [old, now].flatMap((m) => (m ? span(m) : [])));
  const [lo, hi] = [Math.min(...times), Math.max(...times)];
  const pad = Math.max((hi - lo) * 0.15, 2000);
  const [from, to] = [Math.max(lo - pad, 0), hi + pad];
  const [width, height, inset] = [200, 28, 4];
  const x = (at: number) => inset + ((at - from) / (to - from)) * (width - 2 * inset);
  const inRange = (m: LaneItem) => span(m).some((t) => t >= from && t <= to) || (span(m)[0] < from && span(m)[1] > to);
  const changed = new Set(changes.flatMap(({ old, now }) => [old?.of, now?.of]));
  const unchanged = lists.flatMap(([, b]) => b).filter((m) => !changed.has(m.of) && inRange(m));
  const when = (m: LaneItem) => span(m).map((t) => formatScriptTime(t / 1000, 2)).join("–");
  /** An item drawn in `color`: a range as a band, a moment as a line. */
  const draw = (m: LaneItem, key: string, color: string, dashed: boolean, band?: string) => {
    const [a, b] = span(m);
    const stroke = { stroke: color, strokeWidth: 1.5, strokeDasharray: dashed ? "3 2" : undefined };
    return b === undefined
      ? <line key={key} x1={x(a)} x2={x(a)} y1={0} y2={height} {...stroke} />
      : <rect key={key} x={x(a)} width={Math.max(x(b) - x(a), 1)} y={height / 2} height={height / 2} style={{ fill: band ?? "none" }} {...stroke} />;
  };
  const ticks = timeTicks(from / 1000, to / 1000, 3);
  const lines = changes.map(({ old, now }) => {
    const { kind } = (now ?? old)!;
    if (!old) return `Added ${kind} ${now!.name} at ${when(now!)}`;
    if (!now) return `Removed ${kind} ${old.name} at ${when(old)}`;
    const named = old.name === now.name ? old.name : `${old.name} → ${now.name}`;
    if (when(old) === when(now)) return `${old.name === now.name ? "Changed" : "Renamed"} ${kind} ${named} at ${when(now)}`;
    const [a, b] = [span(old), span(now)];
    return `${a.length > 1 && a[1] - a[0] !== b[1] - b[0] ? "Resized" : "Moved"} ${kind} ${named} from ${when(old)} to ${when(now)}`;
  });
  return (
    <Flex direction="column" gap="1">
      <svg width={width} height={height + PREVIEW_AXIS} style={{ display: "block" }}>
        <rect width={width} height={height} rx={3} style={{ fill: "var(--gray-a2)" }} />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t * 1000)} x2={x(t * 1000)} y1={0} y2={height} style={{ stroke: "var(--gray-a4)" }} />
            <text x={x(t * 1000)} y={height + PREVIEW_AXIS - 2} textAnchor="middle" fontSize={9} style={{ fill: "var(--gray-11)" }}>
              {formatTimeTick(t)}
            </text>
          </g>
        ))}
        {unchanged.map((m, i) => draw(m, `u${i}`, "var(--gray-8)", false, "var(--gray-a3)"))}
        {changes.map(({ old }, i) => old && draw(old, `o${i}`, PIECE_STYLES.removed.color, true, PIECE_STYLES.removed.band))}
        {changes.map(({ now }, i) => now && draw(now, `n${i}`, PIECE_STYLES.added.color, false, PIECE_STYLES.added.band))}
        {/* Each moved one joined to where it went, halfway up. */}
        {changes.map(({ old, now }, i) => old && now && span(old)[0] !== span(now)[0] && (
          <line key={`m${i}`} x1={x(span(old)[0])} x2={x(span(now)[0])} y1={height / 4} y2={height / 4} strokeWidth={1} style={{ stroke: PIECE_STYLES.moved.color }} />
        ))}
      </svg>
      {lines.slice(0, MARKER_DIFF_LINES).map((line, i) => <Text key={i} size="1" color="gray">{line}</Text>)}
      {lines.length > MARKER_DIFF_LINES && <Text size="1" color="gray">and {lines.length - MARKER_DIFF_LINES} more</Text>}
    </Flex>
  );
}
