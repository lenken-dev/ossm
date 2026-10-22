import { Box, Flex, IconButton, Text } from "@radix-ui/themes";
import { LockClosedIcon, LockOpen1Icon } from "@radix-ui/react-icons";
import { lightChapters, markerColor, type Bookmark, type Chapter } from "../funscript/markers";
import { NamePopover } from "./NamePopover";
import type { Markers } from "./useMarkers";
import type { Viewport } from "./viewport";

/** Height of the marker lane below the graph, in px. */
export const LANE_HEIGHT = 24;
/** How the selected markers show in the lane. */
const SELECTED_MARKER = { outline: "2px solid var(--accent-9)", outlineOffset: -2 };
/** Width of the grips on a chapter's edges in the lane, in px. */
const MARKER_GRIP = 6;

/**
 * The marker lane below the graph, in the `viewport`'s time,
 * with the `markers`' selection, presses and name field; `locked`, it takes
 * no presses, and `lock`, in the advanced editor, is the lock beside it.
 */
export function MarkerLane({ markers, chapters, bookmarks, viewport, locked, lock }: {
  markers: Markers;
  chapters: Chapter[];
  bookmarks: Bookmark[];
  viewport: Viewport;
  locked: boolean;
  lock: { unlocked: boolean; toggle: () => void } | null;
}) {
  const { marked, naming, markerDown, closeNaming, removeNamed, laneDown, laneEnter, laneLeave } = markers;
  const { x, width, inView } = viewport;

  const light = lightChapters(chapters);

  return (
    // The marker lane, in the graph's time: chapters as bands, touching ones in alternating shades, bookmarks as flags over them; names cut off where there is no room.
    // A press on a marker selects it; on empty lane, a click adds a bookmark and a drag draws a chapter.
    // In the advanced editor, its lock beside it, where the lane stops short of the graph's end.
    // The locked lane takes no pointer, so its hover shows this, the lock its own.
    <Flex gap="2" flexShrink="0" title={locked ? "Unlock to edit" : undefined}>
      <Box
        position="relative"
        flexGrow="1"
        height={`${LANE_HEIGHT}px`}
        onPointerDown={laneDown}
        onPointerEnter={laneEnter}
        onPointerLeave={laneLeave}
        // The advanced editor's document has no markers, so the lane takes no presses there until unlocked.
        style={{ borderRadius: 6, background: "var(--gray-a2)", overflow: "hidden", userSelect: "none", touchAction: "none", cursor: "crosshair", pointerEvents: locked ? "none" : undefined }}
      >
        {/* The empty lane says what a press on it does. */}
        {!locked && !naming && !chapters.length && !bookmarks.length && (
          <Text as="div" size="1" color="gray" align="center" style={{ lineHeight: `${LANE_HEIGHT}px`, pointerEvents: "none" }}>
            Click to add a bookmark, drag to add a chapter
          </Text>
        )}
        {chapters.map((c, i) => {
          if (!inView(c.start, c.end)) return null;
          // Kept in view, so the name of a chapter that starts before it still shows; it ends at the first flag on it, which goes over it.
          const left = Math.max(x(c.start), 0);
          const flag = bookmarks.find((b) => x(b.time) >= left && b.time < c.end);
          return (
            <Box
              key={i}
              position="absolute"
              height="100%"
              onPointerDown={(e) => markerDown(e, c)}
              style={{ left, width: Math.min(x(c.end), width) - left, background: light[i] ? "var(--gray-a3)" : "var(--gray-a5)", cursor: "grab", ...(marked.has(c) && SELECTED_MARKER) }}
            >
              <Text as="div" size="1" truncate style={{ maxWidth: flag && x(flag.time) - left, boxSizing: "border-box", lineHeight: `${LANE_HEIGHT}px`, padding: "0 4px" }}>
                {c.name}
              </Text>
              {/* Grips on its edges in view resize it. */}
              {(["start", "end"] as const).filter((side) => x(c[side]) >= 0 && x(c[side]) <= width).map((side) => (
                <Box
                  key={side}
                  position="absolute"
                  top="0"
                  height="100%"
                  onPointerDown={(e) => markerDown(e, c, [side])}
                  style={{ [side === "start" ? "left" : "right"]: 0, width: MARKER_GRIP, cursor: "ew-resize" }}
                />
              ))}
            </Box>
          );
        })}
        {/* Each flag's name runs up to the next one; they are sorted by time. */}
        {bookmarks.map((b, i) => inView(b.time, b.time) && (
          <Text
            key={i}
            as="div"
            size="1"
            truncate
            onPointerDown={(e) => markerDown(e, b)}
            style={{
              position: "absolute",
              // Its 2px edge centred on its time, like its line through the graph.
              left: x(b.time) - 1,
              maxWidth: bookmarks[i + 1] && x(bookmarks[i + 1].time) - x(b.time),
              boxSizing: "border-box",
              height: "100%",
              lineHeight: `${LANE_HEIGHT}px`,
              padding: "0 4px",
              borderLeft: `2px solid var(--${markerColor(b.name)}-9)`,
              // Opaque, so it hides what it covers.
              background: `linear-gradient(var(--${markerColor(b.name)}-a4), var(--${markerColor(b.name)}-a4)), var(--color-panel-solid)`,
              cursor: "grab",
              ...(marked.has(b) && SELECTED_MARKER),
            }}
          >
            {b.name}
          </Text>
        ))}
        {/* Suggests the names in the script. */}
        {naming && (
          <NamePopover
            initial={naming.name}
            anchor={{ position: "absolute", left: Math.max(x(naming.from), 0), width: Math.min(x(naming.to), width) - Math.max(x(naming.from), 0), height: "100%", pointerEvents: "none" }}
            suggestions={[...new Set([...chapters, ...bookmarks].map((m) => m.name))]}
            onName={(name) => closeNaming(name)}
            onCancel={() => closeNaming(null)}
            onRemove={naming.remove && removeNamed}
          />
        )}
      </Box>
      {lock && (
        <IconButton
          variant="soft"
          color="gray"
          aria-pressed={lock.unlocked}
          aria-label={lock.unlocked ? "Lock markers" : "Unlock markers"}
          title={lock.unlocked ? "Lock the markers" : "Unlock the markers, to edit the main script's chapters and bookmarks here"}
          onClick={lock.toggle}
          style={{ width: LANE_HEIGHT, height: LANE_HEIGHT }}
        >
          {lock.unlocked ? <LockOpen1Icon /> : <LockClosedIcon />}
        </IconButton>
      )}
    </Flex>
  );
}
