import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Box, Button, Callout, Flex, Slider, Text, TextField } from "@radix-ui/themes";
import { DownloadIcon, ExclamationTriangleIcon, FileIcon, UploadIcon } from "@radix-ui/react-icons";
import { bisector } from "d3";
import { usePersistedState } from "../hooks/usePersistedState";
import { formatScriptTime, formatTimeTick, readFunscript, timeTicks } from "../StreamPanel";
import { LabeledSlider } from "../TrajectoryPanel";
import { GraphLayout } from "./GraphPage";

interface Action {
  /** Time in ms. */
  at: number;
  /** 0 (deep end) to 100 (shallow end). */
  pos: number;
}

interface Script {
  name: string;
  /** Sorted by time, no two at the same time. */
  actions: Action[];
}

const EMPTY: Script = { name: "untitled", actions: [] };

/** Visible time range, in ms. */
const MIN_SPAN = 500;
const MAX_SPAN = 120_000;

/** Height of the time axis below the graph and space above and below the points, in px. */
const AXIS = 20;
const PAD = 10;

const LINE_COLOR = "#ec4899";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const byTime = bisector((a: Action) => a.at).left;

export default function EditorPage() {
  // Kept across reloads, so switching tabs or closing the page does not lose the work.
  const [script, setScript] = usePersistedState<Script>("ossm:editorScript", EMPTY, localStorage);
  const [view, setView] = usePersistedState("ossm:editorView", { from: 0, span: 10_000 });
  const [error, setError] = useState<string | null>(null);
  /** The point being dragged. */
  const [active, setActive] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(boxRef.current!);
    return () => observer.disconnect();
  }, []);

  // The wheel scrolls through time, with Ctrl it zooms around the pointer. Not passive, to keep the page from scrolling.
  useEffect(() => {
    const el = boxRef.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      setView((v) => {
        if (!(e.ctrlKey || e.metaKey)) return { ...v, from: Math.max(v.from + ((e.deltaX || e.deltaY) / rect.width) * v.span, 0) };
        const span = clamp(v.span * Math.exp(e.deltaY * 0.002), MIN_SPAN, MAX_SPAN);
        return { from: Math.max(v.from + fraction * (v.span - span), 0), span };
      });
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [setView]);

  const { actions } = script;
  const plotHeight = height - AXIS;
  const x = (at: number) => ((at - view.from) / view.span) * width;
  const y = (pos: number) => PAD + (1 - pos / 100) * (plotHeight - 2 * PAD);
  /** The script time and position under the pointer. */
  const pointerAt = (e: { clientX: number; clientY: number }) => {
    const rect = boxRef.current!.getBoundingClientRect();
    return {
      at: Math.round(view.from + ((e.clientX - rect.left) / width) * view.span),
      pos: Math.round(clamp(100 - ((e.clientY - rect.top - PAD) / (plotHeight - 2 * PAD)) * 100, 0, 100)),
    };
  };

  /** Drag point `i`; it stays between its neighbours, so the actions stay sorted. */
  const drag = (e: PointerEvent<Element>, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const svg = e.currentTarget.closest("svg")!;
    setActive(i);
    const move = (m: globalThis.PointerEvent) => {
      const { at, pos } = pointerAt(m);
      setScript((s) => {
        const a = s.actions.slice();
        a[i] = { at: clamp(at, i > 0 ? a[i - 1].at + 1 : 0, i < a.length - 1 ? a[i + 1].at - 1 : Infinity), pos };
        return { ...s, actions: a };
      });
    };
    svg.setPointerCapture(e.pointerId);
    svg.addEventListener("pointermove", move as EventListener);
    svg.addEventListener("lostpointercapture", () => {
      svg.removeEventListener("pointermove", move as EventListener);
      setActive(null);
    }, { once: true });
  };

  /** Add a point under the pointer and keep dragging it. */
  const add = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const point = pointerAt(e);
    if (point.at < 0) return;
    const i = byTime(actions, point.at);
    if (actions[i]?.at === point.at) return;
    setScript((s) => ({ ...s, actions: [...s.actions.slice(0, i), point, ...s.actions.slice(i)] }));
    drag(e, i);
  };

  const remove = (i: number) => setScript((s) => ({ ...s, actions: s.actions.filter((_, j) => j !== i) }));

  const open = async (file: File) => {
    try {
      const parsed = await readFunscript(file);
      setScript({ name: file.name.replace(/\.funscript$/, ""), actions: Array.from(parsed.at, (at, i) => ({ at, pos: parsed.pos[i] })) });
      setView((v) => ({ ...v, from: 0 }));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const save = () => {
    const json = JSON.stringify({ version: "1.0", inverted: false, range: 100, actions });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob([json], { type: "application/json" })),
      download: `${script.name || "untitled"}.funscript`,
    });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // The points in view and one beyond each edge, so the line reaches the edges.
  // ponytail: all points in view are drawn as SVG; zoomed out on a dense script that is thousands of nodes, switch to canvas if it lags.
  const first = Math.max(byTime(actions, view.from) - 1, 0);
  const last = Math.min(byTime(actions, view.from + view.span) + 1, actions.length);
  const visible = actions.slice(first, last);
  const end = actions.length ? actions[actions.length - 1].at : 0;

  const sidebar = (
    <Flex direction="column" gap="3" p="3">
      <input
        ref={input}
        type="file"
        accept=".funscript"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void open(file);
          e.target.value = "";
        }}
      />
      <Flex gap="2">
        <Button
          variant="soft"
          style={{ flex: 1 }}
          onClick={() => {
            if (actions.length && !confirm("Discard the current script?")) return;
            setScript(EMPTY);
            setView((v) => ({ ...v, from: 0 }));
          }}
        >
          <FileIcon /> New
        </Button>
        <Button variant="soft" style={{ flex: 1 }} onClick={() => input.current?.click()}>
          <UploadIcon /> Open
        </Button>
      </Flex>
      <Box>
        <Text as="label" size="2" weight="medium" mb="1" style={{ display: "block" }} htmlFor="editor-name">Name</Text>
        <TextField.Root id="editor-name" value={script.name} onChange={(e) => setScript({ ...script, name: e.target.value })} />
      </Box>
      <Button disabled={actions.length < 2} onClick={save}>
        <DownloadIcon /> Save
      </Button>
      {error && (
        <Callout.Root color="red" size="1">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      <Text size="2" color="gray">
        {actions.length} points · {formatScriptTime(end / 1000)}
      </Text>
      <LabeledSlider
        label="Visible time"
        value={view.span / 1000}
        display={`${(view.span / 1000).toFixed(1)} s`}
        min={MIN_SPAN / 1000}
        max={MAX_SPAN / 1000}
        step={0.5}
        onChange={(s) => setView({ ...view, span: s * 1000 })}
      />
      <Text size="1" color="gray">
        Click to add a point, drag a point to move it, right-click it to delete it. Scroll to move through time,
        Ctrl+scroll to zoom.
      </Text>
    </Flex>
  );

  const content = (
    <Flex direction="column" gap="3" p="3" height="100%">
      <Box ref={boxRef} position="relative" flexGrow="1" minHeight="120px" style={{ borderRadius: 6, background: "var(--gray-a2)", overflow: "hidden" }}>
        <svg width={width} height={height} onPointerDown={add} style={{ display: "block", cursor: "crosshair", touchAction: "none", userSelect: "none" }}>
          {[0, 50, 100].map((pos) => (
            <line key={pos} x1={0} x2={width} y1={y(pos)} y2={y(pos)} style={{ stroke: "var(--gray-a5)" }} />
          ))}
          {timeTicks(view.from / 1000, (view.from + view.span) / 1000).map((t) => (
            <g key={t}>
              <line x1={x(t * 1000)} x2={x(t * 1000)} y1={0} y2={plotHeight} style={{ stroke: "var(--gray-a4)" }} />
              <text x={x(t * 1000)} y={height - 6} textAnchor="middle" fontSize={11} style={{ fill: "var(--gray-11)" }}>
                {formatTimeTick(t)}
              </text>
            </g>
          ))}
          <polyline
            points={visible.map((a) => `${x(a.at)},${y(a.pos)}`).join(" ")}
            fill="none"
            stroke={LINE_COLOR}
            strokeWidth={2}
            strokeLinejoin="round"
          />
          {visible.map((a, j) => (
            <circle
              key={first + j}
              cx={x(a.at)}
              cy={y(a.pos)}
              r={first + j === active ? 7 : 5}
              fill={LINE_COLOR}
              style={{ cursor: "grab" }}
              onPointerDown={(e) => e.button === 0 && drag(e, first + j)}
              onContextMenu={(e) => {
                e.preventDefault();
                remove(first + j);
              }}
            />
          ))}
          {active !== null && actions[active] && (
            <text
              x={x(actions[active].at)}
              y={y(actions[active].pos) + (actions[active].pos > 80 ? 22 : -12)}
              textAnchor="middle"
              fontSize={12}
              style={{ fill: "var(--gray-12)" }}
            >
              {formatScriptTime(actions[active].at / 1000, 2)} · {Math.round(actions[active].pos)}
            </text>
          )}
        </svg>
        {/* As in the player: 100 (top) is the shallow end, out towards home. */}
        <Text size="1" color="gray" style={{ position: "absolute", top: 4, right: 8, pointerEvents: "none" }}>Out</Text>
        <Text size="1" color="gray" style={{ position: "absolute", bottom: AXIS + 4, right: 8, pointerEvents: "none" }}>In</Text>
      </Box>
      <Slider
        aria-label="Scroll through time"
        min={0}
        max={Math.max(end, view.span)}
        step={10}
        value={[view.from]}
        onValueChange={([from]) => setView({ ...view, from })}
      />
    </Flex>
  );

  return <GraphLayout sidebar={sidebar} content={content} />;
}
