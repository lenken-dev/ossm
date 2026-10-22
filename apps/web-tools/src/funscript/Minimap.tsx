import { useMemo, useRef, type PointerEvent, type RefObject } from "react";
import { dragSeeking } from "../drag";
import { useElementSize } from "../hooks/useElementSize";
import { bandOf, type Region } from "../editor/model";
import { lightChapters, markerColor, type Bookmark, type Chapter } from "./markers";
import { LINE_COLOR, type Action } from "./model";

/** Height of the minimap of the whole script below the graph, in px. */
const MINIMAP_HEIGHT = 40;

/**
 * The minimap below the graph: the whole script, `total` ms across, with its
 * chapters shaded, the line (upside down if `reverse`), the bookmarks, the
 * playhead at `playheadAt` (null for none) and the graph's time, `window`.
 * In the editor also the `regions`' bands, in the advanced editor the main
 * script's other points behind its own (`context`), and the `selected` runs
 * over the line.
 *
 * Dragging moves the window, calling `onDrag` with its start; pressed outside
 * it, it centres on the pointer first, as in a code editor's minimap. While
 * `media` plays, it pauses for the drag and plays on after, and `onDrag` is
 * told it was `playing`.
 */
export function Minimap({ actions, total, chapters, bookmarks, window: { from, span }, onDrag, playheadAt, media, reverse = false, regions = [], context = [], selected }: {
  actions: Action[];
  total: number;
  chapters: Chapter[];
  bookmarks: Bookmark[];
  window: { from: number; span: number };
  onDrag: (from: number, playing: boolean) => void;
  playheadAt: number | null;
  media?: RefObject<HTMLMediaElement | null>;
  reverse?: boolean;
  regions?: Region[];
  context?: Action[][];
  /** The selected points, as indices into `of`. */
  selected?: { of: Action[]; indices: Set<number> };
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const { width } = useElementSize(svgRef);

  const x = (at: number) => (at / total) * width;
  const y = (pos: number) => 2 + (1 - (reverse ? 100 - pos : pos) / 100) * (MINIMAP_HEIGHT - 4);

  const drag = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    const left = target.getBoundingClientRect().left;
    const at = (m: { clientX: number }) => ((m.clientX - left) / width) * total;
    const pressed = at(e);
    const offset = pressed >= from && pressed <= from + span ? pressed - from : span / 2;
    const playing = dragSeeking(media?.current, target, e.pointerId, (m) => onDrag(at(m) - offset, playing));
    onDrag(pressed - offset, playing);
  };

  // Built only when they change, not on every frame or pointer move.
  const contextPath = useMemo(() => context.map((run) => `M${run.map((a) => `${x(a.at)},${y(a.pos)}`).join("L")}`).join(""), [context, width, total, reverse]);
  const line = useMemo(() => actions.map((a) => `${x(a.at)},${y(a.pos)}`).join(" "), [actions, width, total, reverse]);
  const selectedPath = useMemo(() => {
    if (!selected) return "";
    const { of, indices } = selected;
    return of.map((a, i) => indices.has(i) ? `${indices.has(i - 1) ? "L" : "M"}${x(a.at)},${y(a.pos)}${indices.has(i - 1) ? "" : "l0,0"}` : "").join("");
  }, [selected?.of, selected?.indices, width, total, reverse]);
  const light = lightChapters(chapters);

  return (
    <svg
      ref={svgRef}
      height={MINIMAP_HEIGHT}
      aria-label="Minimap"
      onPointerDown={drag}
      style={{ display: "block", flexShrink: 0, width: "100%", borderRadius: 6, background: "var(--gray-a2)", touchAction: "none", userSelect: "none" }}
    >
      {chapters.map((c, i) => (
        <rect key={i} x={x(c.start)} width={x(c.end) - x(c.start)} height={MINIMAP_HEIGHT} style={{ fill: light[i] ? "var(--gray-a3)" : "var(--gray-a4)" }} />
      ))}
      {regions.map((r, i) => (
        <rect key={`r${i}`} x={x(r.from)} width={x(r.to) - x(r.from)} height={MINIMAP_HEIGHT} style={{ fill: bandOf(r).fill }} />
      ))}
      {/* The main script's other points behind the advanced editor's. */}
      {context.length > 0 && <path d={contextPath} fill="none" strokeWidth={1} style={{ stroke: "var(--gray-a7)", pointerEvents: "none" }} />}
      {/* ponytail: the whole script as one polyline; fine for thousands of points, thin it out if a long script lags. */}
      <polyline points={line} fill="none" stroke={LINE_COLOR} strokeWidth={1} />
      {/* The selected runs over it, a lone selected point as a dot. */}
      {selected && (
        <path
          d={selectedPath}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ stroke: "var(--gray-12)", pointerEvents: "none" }}
        />
      )}
      {bookmarks.map((b, i) => (
        <line key={`b${i}`} x1={x(b.time)} x2={x(b.time)} y1={0} y2={6} strokeWidth={2} style={{ stroke: `var(--${markerColor(b.name)}-9)` }} />
      ))}
      {playheadAt !== null && <line x1={x(playheadAt)} x2={x(playheadAt)} y1={0} y2={MINIMAP_HEIGHT} style={{ stroke: "var(--gray-12)" }} />}
      <rect
        x={x(from)}
        width={Math.max(x(span), 4)}
        height={MINIMAP_HEIGHT}
        rx={4}
        style={{ fill: "var(--gray-a5)", stroke: "var(--gray-a8)", cursor: "grab" }}
      />
    </svg>
  );
}
