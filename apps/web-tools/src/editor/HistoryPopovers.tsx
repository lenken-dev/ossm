import { Button, Flex, HoverCard, IconButton, Popover, Text } from "@radix-ui/themes";
import { CounterClockwiseClockIcon } from "@radix-ui/react-icons";
import { formatScriptTime } from "../funscript/time";
import { points } from "../funscript/model";
import type { Clip } from "./model";
import type { Timeline } from "./history";
import { bookmarkItem, chapterItem, diffPieces, LanePreview, PreviewGraph, regionItem } from "./previews";

/**
 * The toolbox's undo history button, docked to the Undo button, and its list
 * of the `timeline`'s edits, newest first, each previewing its change; a
 * click on one goes to it with `onJump`.
 */
export function UndoHistory({ timeline, onJump }: { timeline: Timeline; onJump: (index: number) => void }) {
  return (
    <Popover.Root modal>
      <Popover.Trigger>
        <IconButton
          variant="soft"
          color="gray"
          disabled={timeline.states.length < 2}
          aria-label="Undo history"
          title="Undo history"
          style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "1px solid var(--gray-a5)" }}
        >
          <CounterClockwiseClockIcon />
        </IconButton>
      </Popover.Trigger>
      <Popover.Content width="240px" style={{ maxHeight: 400, overflowY: "auto" }}>
        <Flex direction="column" gap="1">
          {/* Newest first; undone edits are dimmed until redone or replaced. */}
          {timeline.states.map((state, k) => (
            <HoverCard.Root key={k} openDelay={100} closeDelay={0}>
              <HoverCard.Trigger>
                <Popover.Close>
                  <Button
                    variant={k === timeline.index ? "soft" : "ghost"}
                    color="gray"
                    style={{ justifyContent: "flex-start", opacity: k > timeline.index ? 0.5 : 1 }}
                    onClick={() => onJump(k)}
                  >
                    <Text truncate>{state.label}</Text>
                  </Button>
                </Popover.Close>
              </HoverCard.Trigger>
              <HoverCard.Content side="right" size="1" maxWidth="232px">
                <Flex direction="column" gap="1">
                  <Text size="1">{state.label}</Text>
                  {k > 0 && (() => {
                    const before = timeline.states[k - 1];
                    const markersChanged = before.chapters !== state.chapters || before.bookmarks !== state.bookmarks;
                    const regionsChanged = before.regions !== state.regions;
                    // A change only to the snippet library has nothing to show but its label.
                    const others = markersChanged || regionsChanged || before.library !== state.library;
                    return <>
                      {(before.actions !== state.actions || !others) && <PreviewGraph pieces={diffPieces(before.actions, state.actions)} />}
                      {markersChanged && <LanePreview lists={[[before.chapters.map(chapterItem), state.chapters.map(chapterItem)], [before.bookmarks.map(bookmarkItem), state.bookmarks.map(bookmarkItem)]]} />}
                      {regionsChanged && <LanePreview lists={[[before.regions.map(regionItem), state.regions.map(regionItem)]]} />}
                    </>;
                  })()}
                </Flex>
              </HoverCard.Content>
            </HoverCard.Root>
          )).reverse()}
          <Text size="1" color="gray" mt="1">Click an entry to go back or forward to it.</Text>
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}

/**
 * The toolbox's clipboard history button, docked to the Paste button, and
 * its list of the latest copies, `history`, newest first, each previewing its
 * points; a click on one pastes it with `onPaste`.
 */
export function ClipboardHistory({ history, onPaste, disabled }: { history: Clip[]; onPaste: (copied: Clip) => void; disabled: boolean }) {
  return (
    <Popover.Root modal>
      <Popover.Trigger>
        <IconButton
          variant="soft"
          color="gray"
          disabled={disabled}
          aria-label="Clipboard history"
          title="Clipboard history"
          style={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0, borderLeft: "1px solid var(--gray-a5)" }}
        >
          <CounterClockwiseClockIcon />
        </IconButton>
      </Popover.Trigger>
      <Popover.Content width="220px">
        <Flex direction="column" gap="1">
          {history.map((copied, i) => (
            <HoverCard.Root key={i} openDelay={100} closeDelay={0}>
              <HoverCard.Trigger>
                <Popover.Close>
                  <Button variant="ghost" color="gray" style={{ justifyContent: "flex-start" }} onClick={() => onPaste(copied)}>
                    {points(copied.actions.length)}{copied.regions.length > 0 && ` · ${copied.regions.length === 1 ? "region" : `${copied.regions.length} regions`}`} · {formatScriptTime(copied.actions[copied.actions.length - 1].at / 1000)}
                  </Button>
                </Popover.Close>
              </HoverCard.Trigger>
              <HoverCard.Content side="right" size="1">
                <PreviewGraph pieces={[{ kind: "plain", points: copied.actions }]} />
              </HoverCard.Content>
            </HoverCard.Root>
          ))}
          <Text size="1" color="gray" mt="1">Click an entry to paste it and make it the clipboard again.</Text>
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}
