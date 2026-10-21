import type { RefObject } from "react";
import { Box, Flex, Separator, Text } from "@radix-ui/themes";
import { markerColor } from "../funscript/markers";
import { SectionHeader } from "../funscript/widgets";
import { formatScriptTime } from "../StreamPanel";
import type { Markers, Playhead } from "./playback";

/**
 * The Markers section of the controls: the script's chapters and bookmarks
 * in time, each bookmark in its colour and the chapter the playhead is in
 * highlighted while the list shows; a click plays from there.
 */
export function MarkersList({ markers, playhead, chapterAt, open, setOpen }: {
  markers: Markers;
  playhead: RefObject<Playhead>;
  /** The index of the chapter the playhead is in, or -1. */
  chapterAt: number;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  return (
    <>
      <SectionHeader title="Markers" open={open} setOpen={setOpen} summary={`${markers.chapters.length + markers.bookmarks.length}`} />
      {open && (
        <Flex direction="column">
          {[...markers.chapters.map((c, k) => ({ name: c.name, at: c.start, end: c.end, k })), ...markers.bookmarks.map((b) => ({ name: b.name, at: b.time, end: null, k: -1 }))]
            .sort((a, b) => a.at - b.at)
            .map(({ name, at, end, k }, i) => (
              <Flex
                key={i}
                align="center"
                gap="2"
                px="1"
                role="button"
                onClick={() => playhead.current.set(at)}
                style={{ minHeight: 28, borderRadius: 4, cursor: "pointer", userSelect: "none", background: k >= 0 && k === chapterAt ? "var(--accent-a4)" : undefined }}
              >
                {/* A bookmark's colour, as in the editor. */}
                {end === null && <Box flexShrink="0" width="8px" height="8px" style={{ borderRadius: "50%", background: `var(--${markerColor(name)}-9)` }} />}
                <Text size="2" truncate style={{ flexGrow: 1 }}>{name}</Text>
                <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                  {formatScriptTime(at / 1000)}{end !== null && `–${formatScriptTime(end / 1000)}`}
                </Text>
              </Flex>
            ))}
        </Flex>
      )}
      <Separator size="4" />
    </>
  );
}
