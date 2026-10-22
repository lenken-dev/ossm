import { useLayoutEffect, useRef } from "react";
import { useThemeContext } from "@radix-ui/themes";
import { LINE_COLOR, type Action } from "../funscript/model";
import { byTime, regionAt, type Region } from "./model";
import type { View, Viewport } from "./viewport";

/** Below this average spacing between the points in view, in px, the points are not drawn, only the line. */
const DOT_SPACING = 6;
/** A run of up to this many neighbouring selected points in view also shows rings on the points. */
const RING_LIMIT = 50;

/** The points of `arr` in `view` and one beyond each edge, so their line reaches the edges. */
const visibleSlice = (arr: Action[], view: View) => arr.slice(Math.max(byTime(arr, view.from) - 1, 0), byTime(arr, view.from + view.span) + 1);

/**
 * The graph's line and points, in the `viewport` over the time `view`: the
 * `context` runs faintly; the `dashed` line behind, its `movedRegions`' points
 * left out, with a lone point's `ring`; `apart`'s line as it was and the
 * `removed` line; the `visible` points, from index `first` of those shown,
 * the `marks` and the `lit` regions' line drawn over, `muted` thin and faded
 * between them, no dots in the `shownRegions`; and the `astray` points red,
 * but the `carried` regions'. With a tool open, `toolOpen`, no region is lit
 * and no dots show.
 */
export function GraphCanvas({ viewport, view, context, visible, first, marks, shownRegions, lit, dashed, apart, removed, muted, toolOpen, astray }: {
  viewport: Viewport;
  view: View;
  context: Action[][];
  visible: Action[];
  first: number;
  marks: Set<number>;
  shownRegions: Region[];
  lit: Region[];
  dashed: { points: Action[]; movedRegions: Region[]; ring: boolean } | null;
  apart: { actions: Action[]; moving: Set<number>; regions: Region[] } | null;
  removed: Action[] | null;
  muted: boolean;
  toolOpen: boolean;
  astray: { points: Action[]; carried: Region[] } | null;
}) {
  const { width, height, x, y } = viewport;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Re-rendered on a theme change, so the canvas picks up its colours. Radix's own context, as the theme's colours change a render after the app's appearance does.
  useThemeContext();

  // The line and points are drawn on a canvas: as SVG, thousands of them in view make scrolling and zooming lag.
  useLayoutEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      [canvas.width, canvas.height] = [Math.round(width * dpr), Math.round(height * dpr)];
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const css = getComputedStyle(canvas);
    Object.assign(ctx, { lineWidth: 2, lineJoin: "round", strokeStyle: css.getPropertyValue("--gray-a7") });
    for (const run of context) {
      ctx.beginPath();
      for (const a of visibleSlice(run, view)) ctx.lineTo(x(a.at), y(a.pos));
      ctx.stroke();
    }
    // With a tool open, the points it was opened on, faint and dashed behind its result; Repeat's only in its pattern box. Moving, the lifted points where they were, alike.
    if (dashed) {
      ctx.save();
      Object.assign(ctx, { lineWidth: 1.5, strokeStyle: css.getPropertyValue("--gray-a9") });
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      // A moved region shows only its dashed outline, not its points' line.
      const { points: a, movedRegions: moved, ring } = dashed;
      let prev: Action | undefined;
      for (const p of visibleSlice(a, view)) {
        const r = regionAt(moved, p.at);
        if (r && prev && regionAt(moved, prev.at) === r) ctx.moveTo(x(p.at), y(p.pos));
        else ctx.lineTo(x(p.at), y(p.pos));
        prev = p;
      }
      // A lone point, which makes no line, as a ring; but a region's, whose band shows.
      if (ring) ctx.arc(x(a[0].at), y(a[0].pos), 5, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.restore();
    }
    // Moved in place, the line as it was where it went through them, from the points either side, dashed alike.
    if (apart) {
      const { actions: was, moving, regions: moved } = apart;
      ctx.save();
      Object.assign(ctx, { lineWidth: 1.5, strokeStyle: css.getPropertyValue("--gray-a9") });
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (let j = Math.max(byTime(was, view.from), 1); j < Math.min(byTime(was, view.from + view.span) + 1, was.length); j++) {
        if (!moving.has(j - 1) && !moving.has(j)) continue;
        const r = regionAt(moved, was[j].at);
        if (r && regionAt(moved, was[j - 1].at) === r) continue;
        ctx.moveTo(x(was[j - 1].at), y(was[j - 1].pos));
        ctx.lineTo(x(was[j].at), y(was[j].pos));
      }
      ctx.stroke();
      ctx.restore();
    }
    if (removed) {
      ctx.save();
      Object.assign(ctx, { globalAlpha: 0.35, lineWidth: 2, strokeStyle: css.getPropertyValue("--red-9") });
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      for (const a of visibleSlice(removed, view)) ctx.lineTo(x(a.at), y(a.pos));
      ctx.stroke();
      ctx.restore();
    }
    Object.assign(ctx, { strokeStyle: LINE_COLOR, fillStyle: LINE_COLOR });
    // A selected region's line shows as the selected points', as does the line joining it to a selected point or region next to it.
    const on = (j: number) => j >= 0 && (marks.has(first + j) || (!toolOpen && !!regionAt(lit, visible[j].at)));
    const between = (j: number) => on(j - 1) && on(j);
    ctx.beginPath();
    visible.forEach((a, j) => (muted && between(j) ? ctx.moveTo(x(a.at), y(a.pos)) : ctx.lineTo(x(a.at), y(a.pos))));
    ctx.stroke();
    // The line through selected points is drawn over; a short run of them in view also shows rings, so zoomed in, a long run's part in view does too.
    const long = new Array<boolean>(visible.length).fill(false);
    for (let j = 0; j < visible.length; ) {
      let end = j;
      while (end < visible.length && marks.has(first + end)) end++;
      if (end - j > RING_LIMIT) long.fill(true, j, end);
      j = Math.max(end, j + 1);
    }
    const line = new Path2D();
    for (let j = 1; j < visible.length; j++) {
      const [a, b] = [visible[j - 1], visible[j]];
      if (!between(j)) continue;
      line.moveTo(x(a.at), y(a.pos));
      line.lineTo(x(b.at), y(b.pos));
    }
    ctx.strokeStyle = css.getPropertyValue("--gray-12");
    ctx.save();
    if (muted) Object.assign(ctx, { lineWidth: 1.5, globalAlpha: 0.45 });
    ctx.stroke(line);
    ctx.restore();
    // Packed this close, the points would only blur the line; a tool's result only shows its line, as its points can't be dragged.
    const showDots = !toolOpen && visible.length * DOT_SPACING < width;
    // One path per look, so drawing stays fast however many points there are.
    const [dots, ringed] = [new Path2D(), new Path2D()];
    visible.forEach((a, j) => {
      const [cx, cy] = [x(a.at), y(a.pos)];
      const ring = !toolOpen && marks.has(first + j) && !long[j];
      // The regions' points only show their line.
      if ((!ring && !showDots) || regionAt(shownRegions, a.at)) return;
      const path = ring ? ringed : dots;
      const r = ring ? 7 : 5;
      path.moveTo(cx + r, cy);
      path.arc(cx, cy, r, 0, 2 * Math.PI);
    });
    ctx.fill(dots);
    ctx.fill(ringed);
    ctx.strokeStyle = css.getPropertyValue("--gray-12");
    ctx.stroke(ringed);
    // Where the points being placed can't go in, they show red over the rest; only those in view, as a selection to move can be the whole script.
    if (astray) {
      const { points, carried } = astray;
      const red = css.getPropertyValue("--red-9");
      ctx.save();
      Object.assign(ctx, { globalAlpha: 0.6, lineWidth: 2, strokeStyle: red, fillStyle: red });
      ctx.beginPath();
      const inView = visibleSlice(points, view);
      for (const a of inView) ctx.lineTo(x(a.at), y(a.pos));
      ctx.stroke();
      const redDots = new Path2D();
      for (const a of inView) {
        if (regionAt(carried, a.at)) continue;
        redDots.moveTo(x(a.at) + 5, y(a.pos));
        redDots.arc(x(a.at), y(a.pos), 5, 0, 2 * Math.PI);
      }
      ctx.fill(redDots);
      ctx.restore();
    }
  });

  return (
    // Kept in the SVG, so the line and points stay between what is drawn under and over them.
    <foreignObject width={width} height={height} style={{ pointerEvents: "none" }}>
      <canvas ref={canvasRef} style={{ display: "block", width, height }} />
    </foreignObject>
  );
}
