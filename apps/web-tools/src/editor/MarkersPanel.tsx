import { Box, Flex, Text } from "@radix-ui/themes";
import { formatScriptTime } from "../StreamPanel";
import { markerColor, type Bookmark, type Chapter, type Marker } from "../funscript/markers";
import type { Markers } from "./useMarkers";

/**
 * The Markers panel, beside the graph: the chapters and bookmarks in time,
 * the selected ones marked. A click on one shows it, and selects it;
 * bookmarks are selected together as on the lane. A double-click renames
 * it. The advanced editor's document has no markers of its own, so there
 * they only show their times, unless its lane is unlocked.
 */
export function MarkersPanel({ markers, chapters, bookmarks, locked, onGoTo }: {
  markers: Markers;
  chapters: Chapter[];
  bookmarks: Bookmark[];
  locked: boolean;
  onGoTo: (t: number) => void;
}) {
  const { marked, markerAnchor, selectMarkers, isChapter, timeOf, markerPicked, rename } = markers;
  const markerRow = (m: Marker, key: string) => (
    <Flex
      key={key}
      align="center"
      gap="2"
      px="1"
      onClick={(e) => {
        if (!locked && markerPicked(e, m)) return;
        if (!locked) {
          markerAnchor.current = m;
          selectMarkers([m]);
        }
        onGoTo(timeOf(m));
      }}
      onDoubleClick={() => !locked && rename([m])}
      style={{ minHeight: 28, borderRadius: 4, cursor: "pointer", userSelect: "none", background: marked.has(m) ? "var(--accent-a4)" : undefined }}
    >
      {/* A bookmark's colour, as its flag in the lane. */}
      {!isChapter(m) && <Box flexShrink="0" width="8px" height="8px" style={{ borderRadius: "50%", background: `var(--${markerColor(m.name)}-9)` }} />}
      <Text size="2" truncate style={{ flexGrow: 1 }}>{m.name}</Text>
      <Text size="1" color="gray" style={{ flexShrink: 0 }}>
        {isChapter(m) ? `${formatScriptTime(m.start / 1000)}–${formatScriptTime(m.end / 1000)}` : formatScriptTime(m.time / 1000)}
      </Text>
    </Flex>
  );
  return <Flex direction="column" gap="3" p="3">
    <Text size="2" weight="medium">Chapters</Text>
    <Flex direction="column">
      {chapters.length ? chapters.map((c, i) => markerRow(c, `c${i}`)) : <Text size="1" color="gray">No chapters. Drag along the lane under the graph to draw one.</Text>}
    </Flex>
    <Text size="2" weight="medium">Bookmarks</Text>
    <Flex direction="column">
      {bookmarks.length ? bookmarks.map((b, i) => markerRow(b, `b${i}`)) : <Text size="1" color="gray">No bookmarks. Click the lane under the graph, or press B, to add one.</Text>}
    </Flex>
  </Flex>;
}
