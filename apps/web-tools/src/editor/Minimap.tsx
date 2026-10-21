import { useMemo, type Dispatch, type PointerEvent, type SetStateAction } from "react";
import { clamp, LINE_COLOR, type Action } from "../funscript/model";
import { lightChapters, markerColor, type Bookmark, type Chapter } from "../funscript/markers";
import { bandOf, type Region } from "./model";
import { capturePointer } from "../drag";

/** Height of the minimap that shows the whole script below the graph, in px. */
const MINIMAP_HEIGHT = 40;

/**
 * The minimap below the graph, to scroll with: the whole script, `total` ms
 * across `width` px, with its chapters shaded, its `regions`' bands, in the
 * advanced editor the main script's other points behind its own (`context`,
 * null outside it), the line with the selected runs over it, the bookmarks,
 * the playhead at `playheadAt` (null without media) and the visible time.
 */
export function Minimap({ width, total, view, setView, actions, kept, selected, chapters, bookmarks, regions, context, playheadAt }: {
  width: number;
  total: number;
  view: { from: number; span: number };
  setView: Dispatch<SetStateAction<{ from: number; span: number }>>;
  actions: Action[];
  /** The points the selection's indices are of. */
  kept: Action[];
  selected: Set<number>;
  chapters: Chapter[];
  bookmarks: Bookmark[];
  regions: Region[];
  context: Action[][] | null;
  playheadAt: number | null;
}) {
  const minimapX = (at: number) => (at / total) * width;
  /**
   * Drag the visible time around in the minimap. Pressed outside it, it
   * centres on the pointer first, as in a code editor's minimap.
   */
  const dragMinimap = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.currentTarget;
    const left = target.getBoundingClientRect().left;
    const at = (m: { clientX: number }) => ((m.clientX - left) / width) * total;
    const pressed = at(e);
    const offset = pressed >= view.from && pressed <= view.from + view.span ? pressed - view.from : view.span / 2;
    const move = (m: { clientX: number }) => setView((v) => ({ ...v, from: clamp(at(m) - offset, 0, total - v.span) }));
    move(e);
    capturePointer(target, e.pointerId, move);
  };

  // Built only when they change, not on every pointer move while placing.
  const minimapY = (pos: number) => 2 + (1 - pos / 100) * (MINIMAP_HEIGHT - 4);
  const minimapContext = useMemo(() => context?.map((run) => `M${run.map((a) => `${minimapX(a.at)},${minimapY(a.pos)}`).join("L")}`).join("") ?? "", [context, width, total]);
  const minimapLine = useMemo(() => actions.map((a) => `${minimapX(a.at)},${minimapY(a.pos)}`).join(" "), [actions, width, total]);
  const minimapSelected = useMemo(
    () => kept.map((a, i) => selected.has(i) ? `${selected.has(i - 1) ? "L" : "M"}${minimapX(a.at)},${minimapY(a.pos)}${selected.has(i - 1) ? "" : "l0,0"}` : "").join(""),
    [kept, selected, width, total],
  );
  const light = lightChapters(chapters);

  return (
    <svg
      width={width}
      height={MINIMAP_HEIGHT}
      aria-label="Minimap"
      onPointerDown={dragMinimap}
      style={{ display: "block", flexShrink: 0, borderRadius: 6, background: "var(--gray-a2)", touchAction: "none", userSelect: "none" }}
    >
      {chapters.map((c, i) => (
        <rect key={i} x={minimapX(c.start)} width={minimapX(c.end) - minimapX(c.start)} height={MINIMAP_HEIGHT} style={{ fill: light[i] ? "var(--gray-a3)" : "var(--gray-a4)" }} />
      ))}
      {regions.map((r, i) => (
        <rect key={`r${i}`} x={minimapX(r.from)} width={minimapX(r.to) - minimapX(r.from)} height={MINIMAP_HEIGHT} style={{ fill: bandOf(r).fill }} />
      ))}
      {/* The main script's other points behind the advanced editor's. */}
      {context && <path d={minimapContext} fill="none" strokeWidth={1} style={{ stroke: "var(--gray-a7)", pointerEvents: "none" }} />}
      {/* ponytail: the whole script as one polyline; fine for thousands of points, thin it out if a long script lags. */}
      <polyline
        points={minimapLine}
        fill="none"
        stroke={LINE_COLOR}
        strokeWidth={1}
      />
      {/* The selected runs over it, a lone selected point as a dot. */}
      <path
        d={minimapSelected}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ stroke: "var(--gray-12)", pointerEvents: "none" }}
      />
      {bookmarks.map((b, i) => (
        <line key={i} x1={minimapX(b.time)} x2={minimapX(b.time)} y1={0} y2={6} strokeWidth={2} style={{ stroke: `var(--${markerColor(b.name)}-9)` }} />
      ))}
      {playheadAt !== null && <line x1={minimapX(playheadAt)} x2={minimapX(playheadAt)} y1={0} y2={MINIMAP_HEIGHT} style={{ stroke: "var(--gray-12)" }} />}
      <rect
        x={minimapX(view.from)}
        width={Math.max(minimapX(view.span), 4)}
        height={MINIMAP_HEIGHT}
        rx={4}
        style={{ fill: "var(--gray-a5)", stroke: "var(--gray-a8)", cursor: "grab" }}
      />
    </svg>
  );
}
