import { useEffect, useRef, useState, type PointerEvent, type RefObject } from "react";
import { Box, Text, Theme, useThemeContext } from "@radix-ui/themes";
import { bisectLeft } from "d3";
import { capturePointer } from "../drag";
import { LINE_COLOR, MACHINE_COLOR } from "../funscript/model";
import type { Funscript } from "../StreamPanel";
import type { Ossm } from "./ble";
import type { OverlayStyle } from "./overlay";
import type { Markers, Playhead } from "./playback";

/** Time constant, in ms, of the machine dot easing toward the notified position; higher is smoother but lags more. */
const MACHINE_SMOOTHING_MS = 60;
/** How often the firmware samples the machine position; it notifies only changes, so a longer gap means it held. */
const POSITION_INTERVAL_MS = 100;

/**
 * The script's raw points around the video time, redrawn every animation
 * frame, a line and the name where each chapter starts. Works without a
 * video (time 0). `notice` says why the machine does not follow. The machine's planned position is a dot on the playhead, and
 * with `machineLine` also a line trailing it.
 */
export function ScriptPreview({ script, chapters, speed, playhead, reverse, videoRef, ossm, machineLine, notice, lineWidth, span: { before, after }, height: cssHeight, overlay }: {
  script: Funscript;
  chapters: Markers["chapters"];
  /** Script time per video time; the script's points show at their video time. */
  speed: number;
  playhead: RefObject<Playhead>;
  reverse: boolean;
  videoRef: RefObject<HTMLMediaElement | null>;
  ossm: Ossm | null;
  machineLine: boolean;
  notice: string | null;
  lineWidth: number;
  /** Time shown before and after the video time, in ms. */
  span: { before: number; after: number };
  /** In px; without, the graph fills its parent. */
  height?: number;
  /** Drawn over the video in this style, filling its parent, in the dark theme for a dark backdrop. */
  overlay?: OverlayStyle;
}) {
  const overlaid = !!overlay;
  // Redrawn on a theme change, so the canvas picks up its colours. Radix's own context, as the theme's colours change a render after the app's appearance does.
  const theme = useThemeContext();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(canvasRef.current!);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (width === 0 || height === 0) return;
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const css = getComputedStyle(canvas);
    const gridColor = css.getPropertyValue("--gray-a5");
    const playheadColor = css.getPropertyValue("--gray-12");
    const chapterColor = css.getPropertyValue("--gray-a9");
    const labelBackground = overlaid ? "rgba(0,0,0,0.7)" : css.getPropertyValue("--color-panel-solid");
    ctx.font = `11px ${css.fontFamily}`;
    ctx.textBaseline = "middle";
    const lineColor = LINE_COLOR;
    const pad = 6;
    const y = (pos: number) => pad + (1 - (reverse ? 100 - pos : pos) / 100) * (height - 2 * pad);

    let frame = 0;
    // The machine position eases toward each 100 ms sample instead of jumping.
    let machine: number | null = null;
    let drawnAt = performance.now();
    // The notified machine positions, at the video times in ms they arrived, for the machine line.
    const trail: { at: number[]; pos: number[] } = { at: [], pos: [] };
    const record = () => {
      const now = playhead.current.get() / speed;
      const pos = ossm?.streamPosition() ?? null;
      // Seeking back starts the trail over.
      if (now < trail.at[trail.at.length - 1]) trail.at.length = trail.pos.length = 0;
      const last = trail.at.length - 1;
      if (pos === null || now === trail.at[last]) return;
      if (now - POSITION_INTERVAL_MS > trail.at[last]) {
        trail.at.push(now - POSITION_INTERVAL_MS);
        trail.pos.push(trail.pos[last]);
      }
      trail.at.push(now);
      trail.pos.push(pos);
    };
    if (machineLine) ossm?.addEventListener("position", record);
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const elapsed = performance.now() - drawnAt;
      drawnAt += elapsed;
      const now = playhead.current.get() / speed;
      const from = now - before;
      const to = now + after;
      const x = (at: number) => ((at - from) / (to - from)) * width;
      const sx = (i: number) => x(script.at[i] / speed);
      ctx.clearRect(0, 0, width, height);

      ctx.strokeStyle = gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const pos of [0, 50, 100]) {
        const py = Math.round(y(pos)) + 0.5;
        ctx.moveTo(0, py);
        ctx.lineTo(width, py);
      }
      ctx.stroke();

      // The points in the window and one beyond each edge, so the line reaches the edges.
      const first = Math.max(bisectLeft(script.at, from * speed) - 1, 0);
      let last = first;
      while (last < script.at.length - 1 && script.at[last] <= to * speed) last++;
      ctx.strokeStyle = lineColor;
      ctx.fillStyle = lineColor;
      ctx.lineWidth = lineWidth;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = first; i <= last; i++) ctx.lineTo(sx(i), y(script.pos[i]));
      ctx.stroke();
      for (let i = first; i <= last; i++) {
        ctx.beginPath();
        ctx.arc(sx(i), y(script.pos[i]), lineWidth + 1, 0, Math.PI * 2);
        ctx.fill();
      }

      // Over the script's line, each in view with its name in a box against the line's top; over
      // the video, a dark halo keeps the line visible on bright frames, as the playhead.
      ctx.lineWidth = 1;
      for (const c of chapters) {
        if (c.start < from * speed || c.start > to * speed) continue;
        const cx = Math.round(x(c.start / speed)) + 0.5;
        ctx.strokeStyle = chapterColor;
        if (overlaid) {
          ctx.shadowColor = "black";
          ctx.shadowBlur = 4;
        }
        ctx.beginPath();
        ctx.moveTo(cx, 0);
        ctx.lineTo(cx, height);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.fillStyle = labelBackground;
        ctx.beginPath();
        ctx.roundRect(cx, 2.5, Math.ceil(ctx.measureText(c.name).width) + 8, 16, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = playheadColor;
        ctx.fillText(c.name, cx + 4, 10.5);
      }

      // Over the video, a dark halo keeps the playhead visible on bright frames.
      const px = Math.round(x(now));
      ctx.strokeStyle = playheadColor;
      ctx.lineWidth = 2;
      if (overlaid) {
        ctx.shadowColor = "black";
        ctx.shadowBlur = 4;
      }
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, height);
      ctx.stroke();
      ctx.shadowBlur = 0;

      const target = ossm?.streamPosition() ?? null;
      machine = target === null || machine === null ? target : machine + (target - machine) * (1 - Math.exp(-elapsed / MACHINE_SMOOTHING_MS));
      if (now < trail.at[trail.at.length - 1]) trail.at.length = trail.pos.length = 0;
      // Dropping all but one point before the window bounds the trail.
      while (trail.at.length > 1 && trail.at[1] < from) {
        trail.at.shift();
        trail.pos.shift();
      }
      // Through the samples and on to the dot.
      if (machineLine && machine !== null && trail.at.length) {
        ctx.strokeStyle = MACHINE_COLOR;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        for (let i = 0; i < trail.at.length; i++) ctx.lineTo(x(trail.at[i]), y(trail.pos[i]));
        ctx.lineTo(px, y(machine));
        ctx.stroke();
      }

      if (machine !== null) {
        ctx.fillStyle = playheadColor;
        ctx.strokeStyle = lineColor;
        ctx.beginPath();
        ctx.arc(px, y(machine), lineWidth + 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      ossm?.removeEventListener("position", record);
    };
  }, [script, chapters, speed, playhead, reverse, theme, width, videoRef, ossm, machineLine, overlaid, height, lineWidth, before, after]);

  /**
   * Drag the graph sideways to seek, as if grabbing the line; playback pauses
   * while dragging so the machine does not follow every seek.
   */
  const seek = (e: PointerEvent<HTMLCanvasElement>) => {
    const media = videoRef.current;
    if (!media) return;
    e.preventDefault();
    const [startX, startTime, wasPlaying] = [e.clientX, playhead.current.get(), !media.paused];
    media.pause();
    const move = (m: globalThis.PointerEvent) =>
      playhead.current.set(startTime - ((m.clientX - startX) / width) * (before + after) * speed);
    capturePointer(e.currentTarget, e.pointerId, move, () => {
      if (wasPlaying) void media.play();
    });
  };

  const graph = (
    <Box position="relative" flexShrink="0" height={cssHeight === undefined ? "100%" : undefined}>
      <canvas
        ref={canvasRef}
        // Over the video, clicks go through to it or move the graph.
        onPointerDown={overlaid ? undefined : seek}
        style={{
          display: "block",
          cursor: overlaid ? undefined : "ew-resize",
          touchAction: "none",
          width: "100%",
          height: cssHeight ?? "100%",
          borderRadius: 6,
          background: overlay ? `rgba(0,0,0,${overlay.background / 100})` : "var(--gray-a2)",
        }}
      />
      {notice && (
        <Text
          size="1"
          color="amber"
          style={{ position: "absolute", top: 6, left: 8, padding: "2px 6px", borderRadius: 4, background: "var(--color-panel-solid)" }}
        >
          Machine not moving: {notice}
        </Text>
      )}
      {/* The graph shows stream positions: 100 (top) is the shallow end, out towards home. */}
      <Text size="1" color="gray" style={{ position: "absolute", top: 4, right: 8 }}>Out</Text>
      <Text size="1" color="gray" style={{ position: "absolute", bottom: 4, right: 8 }}>In</Text>
    </Box>
  );
  // Over the video, the dark theme's colours whatever the app's.
  return overlaid ? <Theme asChild appearance="dark" hasBackground={false}>{graph}</Theme> : graph;
}
