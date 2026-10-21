import { useEffect, useMemo, useRef, useState, type PointerEvent, type RefObject } from "react";
import { capturePointer } from "../drag";
import { lightChapters, markerColor } from "../funscript/markers";
import { LINE_COLOR } from "../funscript/model";
import type { Funscript } from "../StreamPanel";
import type { Markers, Playhead } from "./playback";

/** Height of the minimap of the whole script below the graph, in px. */
const MINIMAP_HEIGHT = 40;

/**
 * The whole script with its markers, the graph's time and the playhead, as
 * in the editor's minimap. Dragging moves the graph's time and with it the
 * playhead; pressed outside the graph's time, it centres on the pointer
 * first. Playback pauses while dragging, as in the graph.
 */
export function ScriptMinimap({ script, markers: { chapters, bookmarks }, speed, playhead, reverse, videoRef, span: { before, after } }: {
  script: Funscript;
  markers: Markers;
  speed: number;
  playhead: RefObject<Playhead>;
  reverse: boolean;
  videoRef: RefObject<HTMLMediaElement | null>;
  span: { before: number; after: number };
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const shownRef = useRef<SVGGElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(svgRef.current!);
    return () => observer.disconnect();
  }, []);

  const total = script.at[script.at.length - 1] || 1;
  const x = (at: number) => (at / total) * width;
  const light = lightChapters(chapters);
  const points = useMemo(
    () => Array.from(script.at, (at, i) => `${(at / total) * width},${2 + (1 - (reverse ? 100 - script.pos[i] : script.pos[i]) / 100) * (MINIMAP_HEIGHT - 4)}`).join(" "),
    [script, reverse, total, width],
  );

  // The graph's time and the playhead follow the playhead every frame, without rendering.
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      shownRef.current?.setAttribute("transform", `translate(${(playhead.current.get() / total) * width},0)`);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [playhead, total, width]);

  const drag = (e: PointerEvent<SVGSVGElement>) => {
    const media = videoRef.current;
    if (e.button !== 0 || !media) return;
    e.preventDefault();
    const target = e.currentTarget;
    const left = target.getBoundingClientRect().left;
    const at = (m: { clientX: number }) => ((m.clientX - left) / width) * total;
    const now = playhead.current.get();
    const pressed = at(e);
    const grab = pressed >= now - before * speed && pressed <= now + after * speed ? pressed - now : ((after - before) * speed) / 2;
    const wasPlaying = !media.paused;
    media.pause();
    const move = (m: { clientX: number }) => playhead.current.set(at(m) - grab);
    move(e);
    capturePointer(target, e.pointerId, move, () => {
      if (wasPlaying) void media.play();
    });
  };

  return (
    <svg
      ref={svgRef}
      height={MINIMAP_HEIGHT}
      aria-label="Minimap"
      onPointerDown={drag}
      style={{ display: "block", flexShrink: 0, width: "100%", borderRadius: 6, background: "var(--gray-a2)", touchAction: "none", userSelect: "none" }}
    >
      {/* A run of touching chapters alternates light and dark, as in the editor. */}
      {chapters.map((c, i) => (
        <rect key={`c${i}`} x={x(c.start)} width={x(c.end) - x(c.start)} height={MINIMAP_HEIGHT} style={{ fill: light[i] ? "var(--gray-a3)" : "var(--gray-a4)" }} />
      ))}
      <polyline points={points} fill="none" stroke={LINE_COLOR} strokeWidth={1} />
      {bookmarks.map((b, i) => (
        <line key={`b${i}`} x1={x(b.time)} x2={x(b.time)} y1={0} y2={6} strokeWidth={2} style={{ stroke: `var(--${markerColor(b.name)}-9)` }} />
      ))}
      <g ref={shownRef}>
        <rect
          x={-x(before * speed)}
          width={Math.max(x((before + after) * speed), 4)}
          height={MINIMAP_HEIGHT}
          rx={4}
          style={{ fill: "var(--gray-a5)", stroke: "var(--gray-a8)", cursor: "grab" }}
        />
        <line y1={0} y2={MINIMAP_HEIGHT} style={{ stroke: "var(--gray-12)" }} />
      </g>
    </svg>
  );
}
