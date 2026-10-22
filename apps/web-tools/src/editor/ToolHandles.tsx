import type { PointerEvent } from "react";
import { Box } from "@radix-ui/themes";
import { clamp, LINE_COLOR } from "../funscript/model";
import { dragHeight } from "../drag";
import { typed } from "./model";
import { ownScale, type Func, type FuncKey, type ShapeField } from "./generate";
import { PAD, type Viewport } from "./viewport";
import type { Tools } from "./useTool";

/** The selection box's edges, then its corners on top, as the sides dragging them changes. */
export const GRIPS = [["from", null], ["to", null], [null, "high"], [null, "low"], ["from", "high"], ["to", "high"], ["from", "low"], ["to", "low"]] as const;
/** How the selection box and the tools' boxes in the graph fill and outline. */
export const TOOL_BOX = { fill: "var(--accent-a3)", stroke: "var(--accent-9)" };
/** Size of the selection box's grips, in px. */
export const GRIP = 8;
/** Least and first height of the view of Generate's Interval or Speed below the graph, in px. */
export const TIMING_HEIGHT = 80;

/** A grip of a tool's handle in the graph, at `x`, `y` and as wide and high as given; `square` shows it, as the selection box's corners. */
const grip = (key: string, [gx, gy, gw, gh]: number[], cursor: string, down: (e: PointerEvent<SVGRectElement>) => void, square = false) => (
  <rect
    key={key}
    x={gx}
    y={gy}
    width={gw}
    height={gh}
    style={square ? { fill: "var(--color-panel-solid)", stroke: "var(--accent-9)", cursor } : { fill: "transparent", cursor }}
    onPointerDown={down}
  />
);

/** A line from `left` to `right` at `ly`, dashed unless `hidden`, dragged by it or its grip at the right end. */
const gripLine = (key: string, left: number, right: number, ly: number, down: (e: PointerEvent<SVGRectElement>) => void, hidden = false) => (
  <g key={key}>
    {!hidden && <line x1={left} x2={right} y1={ly} y2={ly} strokeDasharray="6 4" strokeWidth={1.5} style={{ stroke: "var(--accent-9)", pointerEvents: "none" }} />}
    {grip(`${key}-line`, [left, ly - GRIP / 2, right - left, GRIP], "ns-resize", down)}
    {grip(`${key}-grip`, [right - GRIP / 2, ly - GRIP / 2, GRIP, GRIP], "ns-resize", down, true)}
  </g>
);

/** Out's and In's curves dashed across the open tool's box, `depth` placing their values, the part shown's bolder. */
const outInCurves = ({ genCurve, genPart }: Tools, depth: (v: number) => number) => (["out", "in"] as const).map((key) => (
  <polyline key={key} points={genCurve(key, (v) => depth(clamp(v, 0, 100)))} fill="none" strokeWidth={genPart === key ? 2 : 1} strokeDasharray="4 3" style={{ stroke: "var(--accent-9)", pointerEvents: "none" }} />
));

/**
 * The handles of the function `key` in the box or, for Interval, Speed and
 * Time, the timing view, `yOf` placing its values: a constant's line and a
 * noise's Min and Max drag up and down, as do a ramp's ends; a wave's line
 * moves its Phase, and its Min and Max together; its first peak in the box
 * moves its Max, the trough after it its Min, and either the Period, the
 * other staying; a pulse's falling edge its Width, around the peak, as does
 * the end of a trapezoid's hold on Max; a spline's knots and line as dragKnot's and
 * addKnot's. Values in whole steps: Out's and In's depths within 0–100,
 * Interval's (ms), Speed's and Time's from 1; none while a field they move is refused.
 */
const funcHandles = (tools: Tools, { x }: Viewport, key: FuncKey, yOf: (v: number) => number) => {
  const { fnSetup, fnBox, genCurve, timingY, timingLow, timingHigh, timingHeight, setFunc, dragHandle, rangeTime, addKnot, dragKnot } = tools;
  const func = fnSetup[key]!;
  const { from, to, low, high } = fnBox!;
  const own = ownScale(key);
  const f = (field: ShapeField) => typed(func[field] ?? "");
  const curve = genCurve(key, own ? timingY : (v) => yOf(clamp(v, 0, 100)));
  const fit = (v: number) => String(own ? Math.max(Math.round(v), 1) : clamp(Math.round(v), 0, 100));
  /** Drag a handle; `move` gets how far the pointer has gone in ms and in the function's value, and gives the fields it changes. */
  const drag = (e: PointerEvent<SVGElement>, move: (dt: number, dv: number) => Partial<Func>) => {
    // Out's and In's are depths, deeper down.
    const scale = own ? (timingHigh - timingLow) / 100 : high > low ? -100 / (high - low) : 0;
    dragHandle(e, (dt, dp) => setFunc(key, (s) => ({ ...s, ...move(dt, dp * scale) })), own ? timingHeight - 2 * PAD : undefined);
  };
  /** A value's line across the box, dragged by it or its grip at the right end; drawn unless it is a constant's, which its curve shows. */
  const line = (field: ShapeField) => {
    const v0 = f(field);
    if (!Number.isFinite(v0)) return null;
    return gripLine(field, x(from), x(to), yOf(v0), (e) => drag(e, (_, dv) => ({ [field]: fit(v0 + dv) })), field === "value");
  };
  /** A square grip `t` ms into the box at value `v`. */
  const point = (k: string, t: number, v: number, cursor: string, down: (e: PointerEvent<SVGElement>) => void) => (Number.isFinite(t + v) ? grip(k, [x(from + t) - GRIP / 2, yOf(v) - GRIP / 2, GRIP, GRIP], cursor, down, true) : null);
  switch (func.shape) {
    case "constant":
      return line("value");
    case "noise":
      return <>{line("min")}{line("max")}</>;
    case "ramp":
      return <>
        {point("start", 0, f("start"), "ns-resize", (e) => drag(e, (_, dv) => ({ start: fit(f("start") + dv) })))}
        {point("end", rangeTime(100) - from, f("end"), "ns-resize", (e) => drag(e, (_, dv) => ({ end: fit(f("end") + dv) })))}
      </>;
    case "spline": {
      // An Interval or Speed spline's knots on its scale, the timing view's.
      const knotY = (v: number) => yOf(own ? timingLow + (v / 100) * (timingHigh - timingLow) : v);
      return <>
        {/* Its line, wider and unseen, adds a knot where clicked. */}
        <polyline points={curve} fill="none" strokeWidth={GRIP} stroke="transparent" style={{ cursor: "copy" }} onPointerDown={(e) => addKnot(e, key)} />
        {func.knots!.map(([t, v], i, knots) => grip(
          `${key}-${i}`,
          [x(rangeTime(t)) - GRIP / 2, knotY(v) - GRIP / 2, GRIP, GRIP],
          i === 0 || i === knots.length - 1 ? "ns-resize" : "move",
          (e) => dragKnot(e, key, knots, i),
          true,
        ))}
      </>;
    }
  }
  // A wave: Max on its first peak, a pulse's in the middle of its Width, Min on the trough half a period after.
  const period = f("period");
  if (!(period > 0)) return null;
  const half = func.shape === "pulse" ? f("width") / 200 : 0.25;
  /** The Phase, in %, that puts a peak `t` ms into the box with a period of `p`, and for a pulse half its Width `h`. */
  const phaseAt = (t: number, p: number, h = half) => String(Math.round((((h - t / p) % 1) + 1) % 1 * 1000) / 10);
  const peak = ((((half - f("phase") / 100) % 1) + 1) % 1) * period;
  // Moved together, Min and Max stop where either would leave its range, keeping the wave's height.
  const [lo, hi] = [Math.min(f("min"), f("max")), Math.max(f("min"), f("max"))];
  const shift = (dv: number) => (own ? Math.max(dv, 1 - lo) : clamp(dv, -lo, 100 - hi));
  return <>
    {/* Its line, wider and unseen, under the grips. */}
    <polyline points={curve} fill="none" strokeWidth={GRIP} stroke="transparent" style={{ cursor: "move" }} onPointerDown={(e) => drag(e, (dt, dv) => ({
      min: fit(f("min") + shift(dv)),
      max: fit(f("max") + shift(dv)),
      phase: phaseAt(peak + dt, period),
    }))} />
    {/* The peak and the trough each set the Period with the other staying. */}
    {point("max", peak, f("max"), "move", (e) => drag(e, (dt, dv) => {
      const p = Math.max(Math.round(period - 2 * dt), 2);
      return { max: fit(f("max") + dv), period: String(p), phase: phaseAt(peak + period / 2 - p / 2, p) };
    }))}
    {point("min", peak + period / 2, f("min"), "move", (e) => drag(e, (dt, dv) => {
      const p = Math.max(Math.round(period + 2 * dt), 2);
      return { min: fit(f("min") + dv), period: String(p), phase: phaseAt(peak, p) };
    }))}
    {/* A pulse's falling edge after the peak, halfway up, sets its Width around the peak, which stays, as does the trough. */}
    {/* A trapezoid's hold on Max ends a quarter of its Width after the peak. */}
    {func.shape === "trapezoid" && point("width", peak + (period * clamp(f("width"), 0, 99)) / 400, f("max"), "ew-resize", (e) => drag(e, (dt) => ({
      width: String(clamp(Math.round(clamp(f("width"), 0, 99) + (400 * dt) / period), 0, 99)),
    })))}
    {func.shape === "pulse" && point("width", peak + period * half, (f("min") + f("max")) / 2, "ew-resize", (e) => drag(e, (dt) => {
      const w = clamp(Math.round(((2 * (period * half + dt)) / period) * 100), 1, 99);
      return { width: String(w), phase: phaseAt(peak, period, w / 200) };
    }))}
  </>;
};

/** The open tool's boxes and handles in the graph, `viewport`'s, as SVG: Scale's, Shift depth's, Generate's and Repeat's. */
export function ToolHandles({ tools, viewport }: { tools: Tools; viewport: Viewport }) {
  const { tool, scaleBox, shiftBox, toolSpan, genBox, genPart, repParams, repBox, fnBox, dragScale, dragShift, dragGenerate, dragRepeat, addPattern, dragPattern } = tools;
  const { x, y, plotHeight } = viewport;
  return <>
    {/* Scale's box, like the selection box: its right edge stretches time, its top and bottom set the depths, the right corners both, its body moves the depths together; all at one time, it only has the depths. */}
    {scaleBox && (() => {
      const [left, right] = [x(scaleBox.t0), x(scaleBox.to)];
      const [top, bottom] = [y(Math.max(scaleBox.low, scaleBox.high)), y(Math.min(scaleBox.low, scaleBox.high))];
      const stretches = scaleBox.t1 > scaleBox.t0;
      const w = Math.max(right - left, 2 * GRIP);
      return (
        <g>
          <rect x={left} y={top} width={right - left} height={bottom - top} strokeDasharray="4 2" style={{ ...TOOL_BOX, cursor: "ns-resize" }} onPointerDown={(e) => dragScale(e, ["low", "high"])} />
          {(["low", "high"] as const).map((v) => grip(v, [(left + right - w) / 2, y(scaleBox[v]) - GRIP / 2, w, GRIP], "ns-resize", (e) => dragScale(e, [v])))}
          {stretches && grip("to", [right - GRIP / 2, top, GRIP, bottom - top], "ew-resize", (e) => dragScale(e, ["to"]))}
          {stretches && (["low", "high"] as const).map((v) => (
            grip(`to-${v}`, [right - GRIP / 2, y(scaleBox[v]) - GRIP / 2, GRIP, GRIP], y(scaleBox[v]) === top ? "nesw-resize" : "nwse-resize", (e) => dragScale(e, ["to", v]), true)
          ))}
        </g>
      );
    })()}
    {/* Shift depth's box, where the points go before Out and In clamp them, past 0 or 100 too; its body drags up and down. Out and In as dashed lines over it, with grips. */}
    {shiftBox && toolSpan && (() => {
      // At least a grip wide and high, for a single point or flat ones.
      const w = Math.max(x(toolSpan.t1) - x(toolSpan.t0), 2 * GRIP);
      const left = (x(toolSpan.t0) + x(toolSpan.t1) - w) / 2;
      const [top, bottom] = [y(toolSpan.hi + shiftBox.offset), y(toolSpan.lo + shiftBox.offset)];
      const h = Math.max(bottom - top, GRIP);
      return (
        <g>
          <rect x={left} y={(top + bottom - h) / 2} width={w} height={h} strokeDasharray="4 2" style={{ ...TOOL_BOX, cursor: "ns-resize" }} onPointerDown={(e) => dragShift(e, "offset")} />
          {(["min", "max"] as const).map((v) => gripLine(v, left, left + w, y(shiftBox[v]), (e) => dragShift(e, v)))}
        </g>
      );
    })()}
    {/* Generate's range box, like the selection box: with Layout shown its edges and corners resize it, its body moves it. Out's and In's curves dashed in it, the shown one's bolder, with its handles. */}
    {genBox && (() => {
      const b = { from: x(genBox.from), to: x(genBox.to), low: y(genBox.low), high: y(genBox.high) };
      const depth = (v: number) => y(genBox.high - (v * (genBox.high - genBox.low)) / 100);
      const position = genPart === "position";
      return (
        <g>
          <rect x={b.from} y={b.high} width={b.to - b.from} height={b.low - b.high} strokeDasharray="4 2" style={{ ...TOOL_BOX, cursor: "move", pointerEvents: position ? undefined : "none" }} onPointerDown={(e) => dragGenerate(e, ["from", "to", "low", "high"])} />
          {outInCurves(tools, depth)}
          {position && GRIPS.map(([h, v]) => grip(
            `${h}-${v}`,
            [h ? b[h] - GRIP / 2 : b.from, v ? b[v] - GRIP / 2 : b.high, h ? GRIP : b.to - b.from, v ? GRIP : b.low - b.high],
            h && v ? ((h === "from") === (v === "high") ? "nwse-resize" : "nesw-resize") : h ? "ew-resize" : "ns-resize",
            (e) => dragGenerate(e, [h, v].filter((s) => s !== null)),
            !!(h && v),
          ))}
          {(genPart === "out" || genPart === "in") && funcHandles(tools, viewport, genPart, depth)}
        </g>
      );
    })()}
    {/*
      Repeat: the copies' time shaded over the pattern box's depths, Out's and In's curves dashed across it, the shown one's bolder, with its handles.
      The pattern box, a click in its time adding a point, its right edge setting Length, its top and bottom its depths; its points over it, joined by a solid line, dragged.
    */}
    {tool?.kind === "repeat" && repParams && (() => {
      const [left, right, top, bottom] = [x(repBox.from), x(repBox.from + repParams.length), y(repParams.top), y(repParams.bottom)];
      const depth = (v: number) => y(repParams.top - (v * (repParams.top - repParams.bottom)) / 100);
      return (
        <g>
          {fnBox && <rect x={left} y={top} width={x(fnBox.to) - left} height={bottom - top} style={{ fill: TOOL_BOX.fill, pointerEvents: "none" }} />}
          {fnBox && outInCurves(tools, depth)}
          <rect x={left} width={right - left} height={plotHeight} fill="transparent" style={{ cursor: "copy" }} onPointerDown={addPattern} />
          <rect x={left} y={top} width={right - left} height={bottom - top} strokeDasharray="4 2" style={{ fill: "none", stroke: TOOL_BOX.stroke, pointerEvents: "none" }} />
          {(["low", "high"] as const).map((v) => grip(v, [left, y(repParams[v === "low" ? "bottom" : "top"]) - GRIP / 2, right - left, GRIP], "ns-resize", (e) => dragRepeat(e, [v])))}
          {grip("to", [right - GRIP / 2, top, GRIP, Math.max(bottom - top, GRIP)], "ew-resize", (e) => dragRepeat(e, ["to"]))}
          {(["low", "high"] as const).map((v) => grip(`to-${v}`, [right - GRIP / 2, (v === "low" ? bottom : top) - GRIP / 2, GRIP, GRIP], v === "high" ? "nesw-resize" : "nwse-resize", (e) => dragRepeat(e, ["to", v]), true))}
          <polyline points={repBox.pattern.filter((a) => a.at <= repBox.from + repParams.length).map((a) => `${x(a.at)},${y(a.pos)}`).join(" ")} fill="none" strokeWidth={2} strokeLinejoin="round" style={{ stroke: "var(--gray-12)", pointerEvents: "none" }} />
          {repBox.pattern.map((a, i) => a.at <= repBox.from + repParams.length && (
            <circle key={i} cx={x(a.at)} cy={y(a.pos)} r={5} style={{ fill: LINE_COLOR, stroke: "var(--gray-12)", cursor: "move" }} onPointerDown={(e) => dragPattern(e, i)} />
          ))}
          {fnBox && (genPart === "out" || genPart === "in") && funcHandles(tools, viewport, genPart, depth)}
        </g>
      );
    })()}
  </>;
}

/** The timing function, Generate's Interval or Speed or Repeat's Time, in the graph's time, over the box's, on a scale of its own from 0 at the bottom; with Timing shown, its handles as Out's and In's in the box. */
export function TimingView({ tools, viewport }: { tools: Tools; viewport: Viewport }) {
  const { timingShown, timingKey, timingHeight, fnBox, timingLow, timingHigh, genCurve, timingY, genPart, timingTall, setTimingTall } = tools;
  const { width, x } = viewport;
  if (!timingShown || !fnBox) return null;
  const key = timingKey!;
  return (
    <Box position="relative" flexShrink="0" height={`${timingHeight}px`} style={{ borderRadius: 6, background: "var(--gray-a2)", overflow: "hidden" }}>
      <svg width={width} height={timingHeight} style={{ display: "block", touchAction: "none", userSelect: "none" }}>
        <rect x={x(fnBox.from)} width={x(fnBox.to) - x(fnBox.from)} height={timingHeight} style={{ fill: TOOL_BOX.fill, pointerEvents: "none" }} />
        {timingLow < timingHigh && <>
          {[0, 0.5, 1].map((f) => (
            <g key={f} style={{ pointerEvents: "none" }}>
              <line x1={0} x2={width} y1={PAD + (1 - f) * (timingHeight - 2 * PAD)} y2={PAD + (1 - f) * (timingHeight - 2 * PAD)} style={{ stroke: "var(--gray-a5)" }} />
              <text x={width - 4} y={PAD + (1 - f) * (timingHeight - 2 * PAD) + (f === 0 ? -3 : f === 1 ? 10 : 3)} textAnchor="end" fontSize={10} style={{ fill: "var(--blue-11)" }}>
                {/* Interval's in s, as its fields, Time's in %. */}
                {key === "interval" ? +((timingLow + f * (timingHigh - timingLow)) / 1000).toFixed(2) : `${Math.round(timingLow + f * (timingHigh - timingLow))}${key === "time" ? "%" : ""}`}
              </text>
            </g>
          ))}
          <polyline points={genCurve(key, timingY)} fill="none" strokeWidth={1.5} style={{ stroke: "var(--blue-9)", pointerEvents: "none" }} />
          {genPart === "timing" && funcHandles(tools, viewport, key, timingY)}
        </>}
      </svg>
      {genPart === "timing" && (
        <Box
          title="Drag to resize"
          style={{
            position: "absolute",
            top: 0,
            left: "calc(50% - 20px)",
            width: 40,
            height: 8,
            borderTop: "4px solid var(--gray-a8)",
            cursor: "ns-resize",
            touchAction: "none",
          }}
          onPointerDown={(e) => dragHeight(e, timingTall, setTimingTall, TIMING_HEIGHT, true)}
        />
      )}
    </Box>
  );
}
