import { Box } from "@radix-ui/themes";
import type { Bookmark, Chapter } from "../funscript/markers";
import { MarkersList } from "../funscript/MarkersList";
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
  const { marked, markerAnchor, selectMarkers, timeOf, markerPicked, rename } = markers;
  return <Box p="3">
    <MarkersList
      chapters={chapters}
      bookmarks={bookmarks}
      highlighted={(m) => marked.has(m)}
      onClick={(m, e) => {
        if (!locked && markerPicked(e, m)) return;
        if (!locked) {
          markerAnchor.current = m;
          selectMarkers([m]);
        }
        onGoTo(timeOf(m));
      }}
      onDoubleClick={(m) => !locked && rename([m])}
      chaptersHint="No chapters. Drag along the lane under the graph to draw one."
      bookmarksHint="No bookmarks. Click the lane under the graph, or press B, to add one."
    />
  </Box>;
}
