import type { ReactNode } from "react";
import { Box, Button, Checkbox, Flex, IconButton, Popover, SegmentedControl, Select, Separator, Slider, Switch, Text, TextField } from "@radix-ui/themes";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, ResetIcon, ShuffleIcon } from "@radix-ui/react-icons";
import { formatScriptTime } from "../StreamPanel";
import { clamp, LINE_COLOR, points, speed, type Action } from "../funscript/model";
import { markerColor, type Bookmark } from "../funscript/markers";
import { regionAt, type Region } from "./model";
import { typed } from "./transforms";
import { extent, GENERATE_DEFAULTS, newSeed, ownScale, REPEAT_DEFAULTS, reshaped, SHAPES, SPANNED, TOOLS, type Func, type FuncKey, type GenerateSetup, type GenPart, type Shape, type ShapeField } from "./generate";
import type { Tools } from "./useTool";

/**
 * The sidebar's tools, on `actions` but the `regions`' points, times shown
 * from `zero`: in the `advanced` editor the list of tools, Repeat needing
 * `selectedCount` of two or more and none while `placing`, or the grid's
 * fields; the open tool's fields, Generate's Markers timing with the
 * `bookmarks`' names, and its Apply and Discard docked at the panel's bottom.
 */
export function ToolPanel({ tools, advanced, actions, regions, bookmarks, zero, selectedCount, placing }: {
  tools: Tools;
  advanced: boolean;
  actions: Action[];
  regions: Region[];
  bookmarks: Bookmark[];
  zero: number;
  selectedCount: number;
  placing: boolean;
}) {
  const { tool, setTool, gridOpen, setGridOpen, gridFields, setGridFields, scale, setScale, shift, setShift, maxSpeed, setMaxSpeed, speedAnchor, setSpeedAnchor, genSetup, setGenSetup, timingView, setTimingView, genRange, setGenRange, genPart, setGenPart, repSetup, setRepSetup, repBox, setRepBox, openTool, repParams, repRun, preview, fnSetup, setFunc, toolBlocked, genMarked, applyTool, invert } = tools;

  /** A part's header in Generate's list, pressed to expand it: its name, then `right`, the part's controls while it is expanded, else a summary. */
  const partHeader = (part: GenPart, label: string, right?: ReactNode) => (
    <Flex gap="2" align="center" justify="between" minHeight="24px">
      <Flex
        align="center"
        gap="2"
        flexGrow="1"
        role="button"
        tabIndex={0}
        aria-expanded={genPart === part}
        onClick={() => setGenPart(part)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setGenPart(part))}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <ChevronRightIcon style={{ flexShrink: 0, transform: genPart === part ? "rotate(90deg)" : undefined }} />
        <Text size="2" weight={genPart === part ? "medium" : undefined}>{label}</Text>
      </Flex>
      {genPart === part ? right : <Text size="1" color="gray">{right}</Text>}
    </Flex>
  );

  /**
   * The open tool's functions as parts of its panel: those of its `timing`,
   * shown with the Timing part, then Out and In, each its own part,
   * collapsed to a header with its shape; expanded, its shape, then its
   * fields, two to a row, values in the function's unit, Speed's none, as Max
   * speed's.
   */
  const funcParts = (timing: [FuncKey, string, string][]) => ([...timing, ["out", "Out", "%"], ["in", "In", "%"]] as [FuncKey, string, string][])
    .filter(([key]) => !ownScale(key) || genPart === "timing")
    .map(([key, label, unit]) => {
      const func = fnSetup[key]!;
      // Out and In as parts, collapsed to a header with their shape.
      const part = key === "out" || key === "in";
      const set = (next: Func) => setFunc(key, () => next);
      /** Periods and Interval's values: kept in whole ms, shown in s, above 0. */
      const inSeconds = (field: ShapeField) => field === "period" || (key === "interval" && SPANNED.includes(field));
      const shapeSelect = (
        <Select.Root size="1" value={func.shape} onValueChange={(v) => set(part
          ? reshaped(func, v as Shape, undefined, key === "out" ? extent(fnSetup.in!)[0] : extent(fnSetup.out!)[1])
          : reshaped(func, v as Shape, typed((tool?.kind === "repeat" ? REPEAT_DEFAULTS.time : GENERATE_DEFAULTS[key as "interval"]).value ?? "")))}>
          <Select.Trigger aria-label={`${label} shape`} />
          <Select.Content>
            {/* Each with a small graph, which the trigger shows too. */}
            {Object.entries(SHAPES).map(([shape, { name, graph }]) => (
              <Select.Item key={shape} value={shape}>
                <Flex gap="2" align="center">
                  <svg width="32" height="16" viewBox="0 0 32 16" fill="none" strokeWidth={1.5} strokeLinejoin="round">
                    <polyline points={graph} stroke={LINE_COLOR} />
                  </svg>
                  {name}
                </Flex>
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      );
      if (part && genPart !== key) return (
        <Box key={key}>
          {partHeader(key, label, <>
            <svg width="32" height="16" viewBox="0 0 32 16" fill="none" strokeWidth={1.5} strokeLinejoin="round" style={{ verticalAlign: "middle", marginRight: 4 }}>
              <polyline points={SHAPES[func.shape].graph} stroke={LINE_COLOR} />
            </svg>
            {SHAPES[func.shape].name}
          </>)}
        </Box>
      );
      return (
        <Flex key={key} direction="column" gap="2">
          {part ? partHeader(key, label, shapeSelect) : (
            <Flex gap="2" align="center" justify="between">
              <Text size="2">{label}</Text>
              {shapeSelect}
            </Flex>
          )}
          <Text size="1" color="gray">
            Drag its handles in the {part ? "graph" : "view below the graph"}
            {func.shape === "spline" ? "; click its line to add a knot, double-click one to remove it." : "."}
          </Text>
          <Flex gap="2" wrap="wrap">
            {/* An Interval, Speed or Time spline's scale too. */}
            {[...SHAPES[func.shape].fields, ...(func.shape !== "spline" || func.max === undefined ? [] : (["min", "max"] as const))].map((field) => (
              <TextField.Root
                key={field}
                type="number"
                // Interval's and a period's seconds by tenths with the wheel and arrows; typed, any.
                step={inSeconds(field) ? 0.1 : "any"}
                aria-label={`${label} ${field}`}
                // Shown in s: a number, so React leaves what is being typed ("0.0") alone.
                value={inSeconds(field) ? (Number.isFinite(typed(func[field] ?? "")) ? typed(func[field]!) / 1000 : "") : func[field] ?? ""}
                onChange={(e) => set({ ...func, [field]: inSeconds(field) && e.target.value ? String(Math.round(Number(e.target.value) * 1000)) : e.target.value })}
                // Not typed negative; the wheel and arrows keep them to 0.1 or more.
                min={inSeconds(field) ? 0.1 : undefined}
                onKeyDown={(e) => inSeconds(field) && e.key === "-" && e.preventDefault()}
                style={{ flex: "1 1 40%", minWidth: 0 }}
              >
                <TextField.Slot side="left">{{ value: "Value", start: "Start", end: "End", min: "Min", max: "Max", period: "Period", phase: "Phase", width: "Width", seed: "Seed" }[field]}</TextField.Slot>
                <TextField.Slot side="right">
                  {field === "seed" ? (
                    <IconButton size="1" variant="ghost" color="gray" aria-label="Reroll" title="Reroll" onClick={() => set({ ...func, seed: newSeed() })}>
                      <ShuffleIcon />
                    </IconButton>
                  ) : { period: "s", phase: "%", width: "%" }[field as string] ?? unit}
                </TextField.Slot>
              </TextField.Root>
            ))}
          </Flex>
          {func.period !== undefined && !(typed(func.period) > 0) && <Text size="1" color="red">Period must be above 0.</Text>}
          {(key === "interval" || key === "time") && SPANNED.some((f) => func[f] !== undefined && !(typed(func[f]) > 0)) && <Text size="1" color="red">{label} must be above 0.</Text>}
        </Flex>
      );
    });

  // In the main script, only a region's Generate.
  if (!advanced && !tool) return null;
  return <>
    {advanced && !tool && !gridOpen && <Separator size="4" />}
    {!tool && !gridOpen ? <>
      {/* The tools, on the selected points or all but the regions', each with a small graph of what it does; Generate needs none, Repeat a pattern of two selected. */}
      <Text size="2" weight="medium">Tools</Text>
      {TOOLS.map(({ kind, name, before, after }) => (
        <Button
          key={kind}
          variant="soft"
          color="gray"
          disabled={(kind === "repeat" ? selectedCount < 2 : kind !== "generate" && kind !== "grid" && actions.every((a) => regionAt(regions, a.at))) || !!placing}
          title={kind === "repeat" ? "Repeat the selected points, two or more" : kind === "grid" ? "Snap points to a grid while it is open" : undefined}
          onClick={() => (kind === "invert" ? invert() : kind === "grid" ? setGridOpen(true) : openTool(kind))}
          style={{ justifyContent: "flex-start" }}
        >
          <svg width="56" height="24" viewBox="0 0 56 24" fill="none" strokeWidth={1.5} strokeLinejoin="round">
            <polyline points={before} style={{ stroke: "var(--gray-8)" }} />
            <polyline points={after} stroke={LINE_COLOR} />
          </svg>
          {name}
        </Button>
      ))}
    </> : tool ? <>
      <Flex gap="2" align="center">
        <IconButton size="1" variant="ghost" color="gray" aria-label="Back to the tools" title="Back to the tools (Escape)" onClick={() => setTool(null)}>
          <ArrowLeftIcon />
        </IconButton>
        <Text size="2" weight="medium">{tool.region ? "Edit region" : TOOLS.find((t) => t.kind === tool.kind)!.name}</Text>
      </Flex>
      {tool.kind === "scale" && ([["time"], ["out", "in"]] as const).map((row) => (
        <Flex key={row[0]} gap="2">
          {row.map((field) => (
            <TextField.Root
              key={field}
              type="number"
              step="any"
              aria-label={{ time: "Time scale", out: "Out depth", in: "In depth" }[field]}
              value={scale[field]}
              onChange={(e) => setScale({ ...scale, [field]: e.target.value })}
              style={{ flex: 1, minWidth: 0 }}
            >
              <TextField.Slot side="left">{{ time: "Time", out: "Out", in: "In" }[field]}</TextField.Slot>
              {field === "time" && <TextField.Slot side="right">%</TextField.Slot>}
            </TextField.Root>
          ))}
        </Flex>
      ))}
      {tool.kind === "shift" && ([["offset"], ["out", "in"]] as const).map((row) => (
        <Flex key={row[0]} gap="2">
          {row.map((field) => (
            <TextField.Root
              key={field}
              type="number"
              step="any"
              aria-label={{ offset: "Depth offset", out: "Out limit", in: "In limit" }[field]}
              value={shift[field]}
              onChange={(e) => setShift({ ...shift, [field]: e.target.value })}
              style={{ flex: 1, minWidth: 0 }}
            >
              <TextField.Slot side="left">{{ offset: "Offset", out: "Out", in: "In" }[field]}</TextField.Slot>
            </TextField.Root>
          ))}
        </Flex>
      ))}
      {/* Speeds without a unit, as depth per second means little to most. */}
      {tool.kind === "speed" && <>
        {/* From 1 to the fastest, mirrored by the field; a typed value past its top leaves it there. Without a segment to slow, only the readout. */}
        {(() => {
          const top = Math.ceil(tool.fastest ?? 0);
          if (top < 1) return <Text size="1" color="gray">Fastest: {tool.fastest === null ? "—" : 0}</Text>;
          const typedLimit = typed(maxSpeed);
          return (
            <Box>
              <Slider aria-label="Max speed" min={1} max={top} step={1} value={[Number.isFinite(typedLimit) ? clamp(typedLimit, 1, top) : top]} onValueChange={([v]) => setMaxSpeed(String(v))} />
              <Flex justify="between" mt="1">
                <Text size="1" color="gray">1</Text>
                <Text size="1" color="gray">Fastest: {top}</Text>
              </Flex>
            </Box>
          );
        })()}
        <Flex gap="2" align="center">
          <TextField.Root type="number" min={0} step="any" aria-label="Max speed" value={maxSpeed} onChange={(e) => setMaxSpeed(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
            <TextField.Slot side="left">Max</TextField.Slot>
          </TextField.Root>
          <SegmentedControl.Root size="1" value={speedAnchor} onValueChange={(v) => setSpeedAnchor(v as "in" | "out")} title="Keep the In or the Out reversals">
            <SegmentedControl.Item value="in">In</SegmentedControl.Item>
            <SegmentedControl.Item value="out">Out</SegmentedControl.Item>
          </SegmentedControl.Root>
        </Flex>
      </>}
      {/* The setup's parts as a list, one expanded at a time: Layout the range box's fields, First and the runs on Out and In, Timing the timing and its function, Out and In theirs. */}
      {tool.kind === "generate" && <>
        {partHeader("position", "Layout", genPart !== "position" && `${genRange.from}–${genRange.to} s`)}
        {genPart === "position" && ([["from", "to"], ["out", "in"]] as const).map((row) => (
          <Flex key={row[0]} gap="2">
            {row.map((field) => (
              <TextField.Root
                key={field}
                type="number"
                step="any"
                aria-label={{ from: "Range start", to: "Range end", out: "Range out depth", in: "Range in depth" }[field]}
                value={genRange[field]}
                onChange={(e) => setGenRange({ ...genRange, [field]: e.target.value })}
                style={{ flex: 1, minWidth: 0 }}
              >
                <TextField.Slot side="left">{{ from: "From", to: "To", out: "Out", in: "In" }[field]}</TextField.Slot>
                {(field === "from" || field === "to") && <TextField.Slot side="right">s</TextField.Slot>}
              </TextField.Root>
            ))}
          </Flex>
        ))}
        {genPart === "position" && <Flex gap="2" align="center" justify="between">
          <Text size="2">First</Text>
          <SegmentedControl.Root size="1" value={genSetup.first} onValueChange={(v) => setGenSetup({ ...genSetup, first: v as "in" | "out" })} title="Start In or Out">
            <SegmentedControl.Item value="in">In</SegmentedControl.Item>
            <SegmentedControl.Item value="out">Out</SegmentedControl.Item>
          </SegmentedControl.Root>
        </Flex>}
        {genPart === "position" && (
          <Flex gap="2">
            {(["outs", "ins"] as const).map((field) => (
              <TextField.Root
                key={field}
                type="number"
                min="1"
                step="1"
                aria-label={field === "outs" ? "Points in a row on Out" : "Points in a row on In"}
                value={genSetup[field] ?? "1"}
                onChange={(e) => setGenSetup({ ...genSetup, [field]: e.target.value })}
                style={{ flex: 1, minWidth: 0 }}
              >
                <TextField.Slot side="left">{field === "outs" ? "Out" : "In"}</TextField.Slot>
                <TextField.Slot side="right">×</TextField.Slot>
              </TextField.Root>
            ))}
          </Flex>
        )}
        {partHeader("timing", "Timing", genPart !== "timing" && { interval: "Interval", speed: "Speed", markers: "Markers" }[genSetup.timing])}
        {/* In a row of its own, across the panel. */}
        {genPart === "timing" && (
          <SegmentedControl.Root
            size="1"
            style={{ width: "100%" }}
            value={genSetup.timing}
            // Markers only while the box holds a bookmark.
            onValueChange={(v) => (v !== "markers" || genMarked) && setGenSetup({ ...genSetup, timing: v as GenerateSetup["timing"] })}
            title="Space the points by a time or a speed, or put them at the bookmarks in the box"
          >
            <SegmentedControl.Item value="interval">Interval</SegmentedControl.Item>
            <SegmentedControl.Item value="speed">Speed</SegmentedControl.Item>
            <SegmentedControl.Item
              value="markers"
              aria-disabled={!genMarked}
              title={genMarked ? undefined : "No bookmarks in the box"}
              style={genMarked ? undefined : { opacity: 0.5, cursor: "not-allowed" }}
            >
              Markers
            </SegmentedControl.Item>
          </SegmentedControl.Root>
        )}
        {/* Markers timing: which bookmark names it puts points at, all at first; in a popover, as there can be many. */}
        {genPart === "timing" && genSetup.timing === "markers" && (() => {
          const names = [...new Set(bookmarks.map((b) => b.name))].sort((a, b) => a.localeCompare(b));
          const skip = genSetup.skip ?? [];
          const used = names.filter((n) => !skip.includes(n)).length;
          return (
            <Flex gap="2" align="center" justify="between">
              <Text size="2">Bookmarks</Text>
              <Popover.Root>
                <Popover.Trigger>
                  <Button size="1" variant="soft" color="gray" title="The bookmark names to put points at">
                    {used === names.length ? "All names" : `${used} of ${names.length} names`} <ChevronDownIcon />
                  </Button>
                </Popover.Trigger>
                {/* Lined up with the button's right edge, which stays put as its label changes width. */}
                <Popover.Content size="1" align="end" maxWidth="240px" style={{ maxHeight: 320, overflowY: "auto" }}>
                  <Flex direction="column" gap="2">
                    {names.map((n) => (
                      <Text key={n} as="label" size="2">
                        <Flex gap="2" align="center">
                          <Checkbox
                            checked={!skip.includes(n)}
                            onCheckedChange={(on) => {
                              const next = on ? skip.filter((o) => o !== n) : [...skip, n];
                              setGenSetup({ ...genSetup, skip: next.length ? next : undefined });
                            }}
                          />
                          <Box flexShrink="0" width="8px" height="8px" style={{ borderRadius: "50%", background: `var(--${markerColor(n)}-9)` }} />
                          <Text truncate>{n}</Text>
                        </Flex>
                      </Text>
                    ))}
                  </Flex>
                </Popover.Content>
              </Popover.Root>
            </Flex>
          );
        })()}
        {genPart === "timing" && genSetup.timing !== "markers" && (
          <Text as="label" size="2">
            <Flex gap="2" align="center">
              <Switch checked={timingView} onCheckedChange={setTimingView} /> Show {genSetup.timing === "speed" ? "Speed" : "Interval"} below the graph
            </Flex>
          </Text>
        )}
        {/* Markers timing has no function. */}
        {funcParts(genSetup.timing === "speed" ? [["speed", "Speed", ""]] : genSetup.timing === "interval" ? [["interval", "Interval", "s"]] : [])}
        <Flex gap="2" align="center" justify="between">
          {/* Of the generated points: their fastest segment and the shortest time between two. */}
          {(() => {
            const made = preview ? [...preview.selected].map((i) => preview.actions[i]) : [];
            const gaps = made.slice(1).map((a, i) => [speed(made[i], a), a.at - made[i].at]);
            return (
              <Text size="1" color="gray">
                Fastest: {gaps.length ? Math.ceil(Math.max(...gaps.map(([s]) => s))) : "—"} · Shortest: {gaps.length ? `${Math.min(...gaps.map(([, dt]) => dt))} ms` : "—"}
              </Text>
            );
          })()}
          <Button size="1" variant="soft" color="gray" onClick={() => setGenSetup(GENERATE_DEFAULTS)}>
            <ResetIcon /> Reset
          </Button>
        </Flex>
      </>}
      {/* Count, then the setup's parts as Generate's: Pattern its box's fields, Time, Out and In their functions. */}
      {tool.kind === "repeat" && <>
        <TextField.Root
          type="number"
          min={1}
          step={1}
          aria-label="Count"
          value={repSetup.count}
          onChange={(e) => setRepSetup({ ...repSetup, count: e.target.value })}
          onKeyDown={(e) => e.key === "-" && e.preventDefault()}
        >
          <TextField.Slot side="left">Count</TextField.Slot>
        </TextField.Root>
        {!repRun && repParams && <Text size="1" color="red">Count must be a whole number, at least 1.</Text>}
        {partHeader("position", "Pattern", genPart !== "position" && `${points(repBox.pattern.length)} · ${repBox.length} s`)}
        {genPart === "position" && <>
          <Text size="1" color="gray">Drag its points in the graph; click in its box to add one, double-click one to remove it. The box's right edge sets its Length.</Text>
          {([["length"], ["out", "in"]] as const).map((row) => (
            <Flex key={row[0]} gap="2">
              {row.map((field) => (
                <TextField.Root
                  key={field}
                  type="number"
                  step={field === "length" ? 0.1 : "any"}
                  min={field === "length" ? 0.1 : undefined}
                  aria-label={{ length: "Pattern length", out: "Pattern out depth", in: "Pattern in depth" }[field]}
                  value={repBox[field]}
                  onChange={(e) => setRepBox({ ...repBox, [field]: e.target.value })}
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <TextField.Slot side="left">{{ length: "Length", out: "Out", in: "In" }[field]}</TextField.Slot>
                  {field === "length" && <TextField.Slot side="right">s</TextField.Slot>}
                </TextField.Root>
              ))}
            </Flex>
          ))}
        </>}
        {partHeader("timing", "Time", genPart !== "timing" && SHAPES[repSetup.time.shape].name)}
        {genPart === "timing" && <>
          <Text size="1" color="gray">Each copy's length, in % of the pattern's; a ramp's or spline's from the first copy to the last.</Text>
          <Text as="label" size="2">
            <Flex gap="2" align="center">
              <Switch checked={timingView} onCheckedChange={setTimingView} /> Show Time below the graph
            </Flex>
          </Text>
        </>}
        {funcParts([["time", "Time", "%"]])}
        <Flex gap="2" align="center" justify="between">
          <Text size="1" color="gray">
            Copies: {repRun ? repRun.starts.length - 1 : "—"} · Ends at: {repRun ? formatScriptTime((repRun.end - zero) / 1000) : "—"}
          </Text>
          <Button size="1" variant="soft" color="gray" onClick={() => setRepSetup(REPEAT_DEFAULTS)}>
            <ResetIcon /> Reset
          </Button>
        </Flex>
      </>}
      {/* At the panel's bottom, docked there while it scrolls, covering what passes under; the padding takes the place of the gap and the panel's own. */}
      <Flex direction="column" gap="2" py="3" mb="-3" style={{ marginTop: "auto", position: "sticky", bottom: 0, background: "var(--color-background)" }}>
        {toolBlocked && <Text size="1" color="red">{toolBlocked}.</Text>}
        <Flex gap="2">
          <Button disabled={!preview || !!toolBlocked} onClick={applyTool} style={{ flex: 1 }}>Apply</Button>
          <Button variant="soft" color="gray" onClick={() => setTool(null)} style={{ flex: 1 }}>Discard</Button>
        </Flex>
      </Flex>
    </> : <>
      {/* The grid, without Apply: editing goes on while it is open. Escape in its fields closes it too, as a tool's. */}
      <Flex gap="2" align="center">
        <IconButton size="1" variant="ghost" color="gray" aria-label="Back to the tools" title="Back to the tools (Escape)" onClick={() => setGridOpen(false)}>
          <ArrowLeftIcon />
        </IconButton>
        <Text size="2" weight="medium">Grid</Text>
      </Flex>
      <Text size="1" color="gray">Points added, dragged and placed go to the nearest line. Leave a field empty to not snap that way.</Text>
      <Flex direction="column" gap="2" onKeyDown={(e) => e.key === "Escape" && setGridOpen(false)}>
        <TextField.Root type="number" min={0} step="any" aria-label="Time interval" value={gridFields.time} onChange={(e) => setGridFields({ ...gridFields, time: e.target.value })}>
          <TextField.Slot side="left">Time every</TextField.Slot>
          <TextField.Slot side="right">s</TextField.Slot>
        </TextField.Root>
        <TextField.Root type="number" min={0} step="any" aria-label="Depth interval" value={gridFields.depth} onChange={(e) => setGridFields({ ...gridFields, depth: e.target.value })}>
          <TextField.Slot side="left">Depth every</TextField.Slot>
        </TextField.Root>
        <TextField.Root aria-label="Depths" placeholder="33, 66" title="Depths of their own, apart by commas" value={gridFields.depths} onChange={(e) => setGridFields({ ...gridFields, depths: e.target.value })}>
          <TextField.Slot side="left">Depths</TextField.Slot>
        </TextField.Root>
      </Flex>
    </>}
  </>;
}
