import type { MouseEvent, ReactNode } from "react";
import { Box, Flex, Text } from "@radix-ui/themes";
import { formatScriptTime } from "./time";
import { markerColor, type Bookmark, type Chapter, type Marker } from "./markers";

/**
 * A script's chapters, then its bookmarks, each under its heading: a
 * chapter with its time range, a bookmark in its colour with its time, the
 * `highlighted` ones marked. An empty group shows its hint, or nothing
 * without one.
 */
export function MarkersList({ chapters, bookmarks, highlighted, onClick, onDoubleClick, chaptersHint, bookmarksHint }: {
  chapters: Chapter[];
  bookmarks: Bookmark[];
  highlighted: (m: Marker) => boolean;
  onClick: (m: Marker, e: MouseEvent) => void;
  onDoubleClick?: (m: Marker) => void;
  chaptersHint?: string;
  bookmarksHint?: string;
}) {
  const row = (m: Marker, key: string, time: string, color?: string) => (
    <Flex
      key={key}
      align="center"
      gap="2"
      px="1"
      role="button"
      onClick={(e) => onClick(m, e)}
      onDoubleClick={onDoubleClick && (() => onDoubleClick(m))}
      style={{ minHeight: 28, borderRadius: 4, cursor: "pointer", userSelect: "none", background: highlighted(m) ? "var(--accent-a4)" : undefined }}
    >
      {/* A bookmark's colour, as its flag in the editor's lane. */}
      {color && <Box flexShrink="0" width="8px" height="8px" style={{ borderRadius: "50%", background: `var(--${color}-9)` }} />}
      <Text size="2" truncate style={{ flexGrow: 1 }}>{m.name}</Text>
      <Text size="1" color="gray" style={{ flexShrink: 0 }}>{time}</Text>
    </Flex>
  );
  const group = (title: string, rows: ReactNode[], hint?: string) => (rows.length || hint ? <>
    <Text size="2" weight="medium">{title}</Text>
    <Flex direction="column">{rows.length ? rows : <Text size="1" color="gray">{hint}</Text>}</Flex>
  </> : null);
  return <Flex direction="column" gap="3">
    {group("Chapters", chapters.map((c, i) => row(c, `c${i}`, `${formatScriptTime(c.start / 1000)}–${formatScriptTime(c.end / 1000)}`)), chaptersHint)}
    {group("Bookmarks", bookmarks.map((b, i) => row(b, `b${i}`, formatScriptTime(b.time / 1000), markerColor(b.name))), bookmarksHint)}
  </Flex>;
}
