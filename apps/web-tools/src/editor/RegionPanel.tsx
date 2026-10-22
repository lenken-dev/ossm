import { Button, Flex, Heading, IconButton, Separator, Text } from "@radix-ui/themes";
import { LockOpen1Icon, MixerHorizontalIcon, Pencil1Icon, TrashIcon } from "@radix-ui/react-icons";
import { points } from "../funscript/model";
import { isInstance, isRepeat, regionKind, regionName, regionTitle, type Region } from "./model";
import { NamePopover, SnippetIcon } from "./NamePopover";

/**
 * The sidebar's section on the selected region, its points locked until
 * unlocked: what made it, its name to rename, its `pointCount` points, Edit
 * (`disabled` while placing), Unlock and Delete, and Save as snippet under a
 * name not `nameTaken` at the library's top level. Both name fields open on
 * its own name and show its label while empty; Save as snippet saves under
 * the label then.
 */
export function RegionPanel({ region, pointCount, disabled, onEdit, onUnlock, onDelete, onRename, onSave, nameTaken }: {
  region: Region;
  pointCount: number;
  disabled: boolean;
  onEdit: () => void;
  onUnlock: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
  onSave: (name: string) => void;
  nameTaken: (name: string) => boolean;
}) {
  /** Its own name: an instance's, a region's only once given. */
  const name = isInstance(region) ? region.snippet.name : region.name;
  return (
    <>
      <Separator size="4" />
      <Heading size="3">{regionKind(region)}</Heading>
      <Flex align="center" gap="2">
        {name ? <Text size="2" weight="medium" truncate>{name}</Text> : <Text size="2" color="gray">Unnamed</Text>}
        <NamePopover initial={name} placeholder={regionName(region)} onName={(n) => n !== regionTitle(region) && onRename(n)}>
          <IconButton size="1" variant="ghost" color="gray" aria-label="Rename" title="Rename"><Pencil1Icon /></IconButton>
        </NamePopover>
      </Flex>
      <Text size="2" color="gray">{points(pointCount)}</Text>
      <Flex gap="2">
        <Button variant="soft" color="gray" style={{ flex: 1 }} disabled={disabled} title={isInstance(region) ? "Edit its points and regions in the advanced editor (E, or double-click it)" : isRepeat(region) ? "Edit its pattern and setup with Repeat (E, or double-click it)" : "Edit its setup and box with Generate (E, or double-click it)"} onClick={onEdit}>
          <MixerHorizontalIcon /> Edit
        </Button>
        <Button variant="soft" color="gray" style={{ flex: 1 }} title="Make its points ordinary points" onClick={onUnlock}>
          <LockOpen1Icon /> Unlock
        </Button>
        <IconButton variant="soft" color="red" aria-label="Delete" title="Delete it with its points (Delete)" onClick={onDelete}>
          <TrashIcon />
        </IconButton>
      </Flex>
      {/* Its points and generator regions, at the top level of the library. */}
      <NamePopover initial={name} fallback={regionName(region)} taken={nameTaken} onName={onSave}>
        <Button variant="soft" color="gray" disabled={pointCount < 2} title="Save its points and regions to the snippet library">
          <SnippetIcon /> Save as snippet
        </Button>
      </NamePopover>
    </>
  );
}
