import { useRef, type ReactElement } from "react";
import { Button, Flex, HoverCard, IconButton, Text, TextField } from "@radix-ui/themes";
import { ChevronRightIcon, DownloadIcon, MagnifyingGlassIcon, MixerHorizontalIcon, Pencil1Icon, PlusIcon, TrashIcon, UploadIcon } from "@radix-ui/react-icons";
import { Stats } from "../funscript/widgets";
import { NamePopover, SnippetIcon } from "./NamePopover";
import { generators } from "./model";
import { entryAt, entryName, isFolder, isPreset, matching, sortedEntries, type Entry, type Folder } from "./library";
import { PreviewGraph } from "./previews";
import type { Library } from "./useLibrary";

/**
 * The Snippets panel, beside the graph: the library as a tree; in the main script, its top area takes rows dropped to the top level.
 * Out of the `advanced` editor, it edits the `library`, but not while
 * `placing`. A snippet's Edit, or New snippet with null, opens it with
 * `onOpenSnippet`.
 */
export function SnippetsPanel({ library: lib, advanced, placing, onOpenSnippet }: {
  library: Library;
  advanced: boolean;
  placing: boolean;
  onOpenSnippet: (path: string[] | null) => void;
}) {
  const { library, shelf, openFolders, setOpenFolders, snippetQuery, setSnippetQuery, rowDrag, dropOn, rowsPicked, nameTaken, insertSnippet, addFolder, renameEntry, deleteEntry, dropInto, dragRow, exportLibrary, importLibrary } = lib;
  /**
   * The library's rows in the folder at `path`, `depth` deep, an open
   * folder's rows after it, each added to `shownRows`. In the main script
   * rows are selected, and dragged onto a folder row to move them there, and
   * a row but a preset's has Rename and Delete, a snippet's also Edit.
   * Everywhere a snippet's row is dragged onto the graph to insert it.
   */
  const shownRows: string[] = [];
  const libraryInput = useRef<HTMLInputElement>(null);
  const libraryRows = (items: Entry[], path: string[], depth: number): ReactElement[] => sortedEntries(items).flatMap((e) => {
    const [name, at] = [entryName(e), [...path, entryName(e)]];
    const key = JSON.stringify(at);
    shownRows.push(key);
    const open = isFolder(e) && (!!snippetQuery || openFolders.includes(key));
    const toggle = () => setOpenFolders((keys) => (open ? keys.filter((k) => k !== key) : [...keys, key]));
    const row = (
      <Flex
        key={key}
        align="center"
        gap="1"
        data-library-row
        onPointerDown={!advanced || !isFolder(e) ? (p) => dragRow(p, at, e, shownRows) : undefined}
        {...(isFolder(e) ? dropInto(at) : {})}
        style={{ paddingLeft: depth * 16, minHeight: 28, borderRadius: 4, userSelect: "none", background: dropOn === key ? "var(--accent-a4)" : !advanced && rowsPicked.has(key) ? "var(--accent-a3)" : undefined }}
      >
        {/* A snippet's name shows a preview beside the panel: its points, its regions' boxes behind, and their stats. */}
        <HoverCard.Root openDelay={300} closeDelay={0} open={isFolder(e) ? false : undefined}>
          <HoverCard.Trigger>
            <Flex
              align="center"
              gap="2"
              flexGrow="1"
              minWidth="0"
              onClick={isFolder(e) ? toggle : undefined}
              onDoubleClick={() => !isFolder(e) && insertSnippet(e)}
              style={{ cursor: isFolder(e) ? "pointer" : undefined, userSelect: "none" }}
            >
              {isFolder(e) ? <ChevronRightIcon style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined }} /> : <SnippetIcon style={{ flexShrink: 0 }} />}
              <Text size="2" truncate>{name}</Text>
            </Flex>
          </HoverCard.Trigger>
          {!isFolder(e) && (
            <HoverCard.Content side="left" size="1">
              <Flex direction="column" gap="3">
                <PreviewGraph pieces={[{ kind: "plain", points: e.actions }]} bands={generators(e.regions)} />
                <Stats actions={e.actions} picked={[...e.actions.keys()]} size="1" />
              </Flex>
            </HoverCard.Content>
          )}
        </HoverCard.Root>
        {!advanced && !isPreset(at) && !isFolder(e) && (
          <IconButton size="1" variant="ghost" color="gray" disabled={placing} aria-label="Edit" title="Edit it in the advanced editor" onClick={() => onOpenSnippet(at)}><MixerHorizontalIcon /></IconButton>
        )}
        {!advanced && !isPreset(at) && <>
          <NamePopover initial={name} taken={(n) => n !== name && nameTaken(path, n)} onName={(n) => n !== name && renameEntry(at, n)}>
            <IconButton size="1" variant="ghost" color="gray" aria-label="Rename" title="Rename"><Pencil1Icon /></IconButton>
          </NamePopover>
          <IconButton size="1" variant="ghost" color="red" aria-label="Delete" title={isFolder(e) ? "Delete it with its contents" : "Delete"} onClick={() => deleteEntry(at)}><TrashIcon /></IconButton>
        </>}
      </Flex>
    );
    return [row, ...(open ? libraryRows((e as Folder).items, at, depth + 1) : [])];
  });

  const shownLibrary = snippetQuery ? matching(shelf, snippetQuery) : shelf;
  return <Flex direction="column" gap="3" p="3">
    <input
      ref={libraryInput}
      type="file"
      accept=".json,application/json"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) void importLibrary(file);
        e.target.value = "";
      }}
    />
    <Flex direction="column" gap="2" {...dropInto([])} style={{ borderRadius: 4, background: dropOn === "[]" ? "var(--accent-a4)" : undefined }}>
      <Text size="2" weight="medium">Snippets</Text>
      {!advanced && <Flex gap="2" wrap="wrap">
        <Button size="1" variant="soft" color="gray" disabled={placing} title="Make a snippet in the advanced editor" onClick={() => onOpenSnippet(null)}>
          <PlusIcon /> New snippet
        </Button>
        <NamePopover taken={(n) => nameTaken([], n)} onName={addFolder}>
          <Button size="1" variant="soft" color="gray"><PlusIcon /> New folder</Button>
        </NamePopover>
        <Button size="1" variant="soft" color="gray" disabled={!library.length} title="Save the library to a file" onClick={exportLibrary}>
          <DownloadIcon /> Export
        </Button>
        <Button size="1" variant="soft" color="gray" title="Merge a library file into the library" onClick={() => libraryInput.current?.click()}>
          <UploadIcon /> Import
        </Button>
      </Flex>}
      {!!shelf.length && (
        <TextField.Root size="1" placeholder="Search" aria-label="Search snippets" value={snippetQuery} onChange={(e) => setSnippetQuery(e.target.value)}>
          <TextField.Slot><MagnifyingGlassIcon /></TextField.Slot>
        </TextField.Root>
      )}
    </Flex>
    <Flex direction="column">
      {shownLibrary.length ? libraryRows(shownLibrary, [], 0) : <Text size="1" color="gray">{shelf.length ? "No matches." : "No snippets yet."}</Text>}
    </Flex>
    {/* The dragged row's icon and name follow the pointer; for several, the first's icon and their count. Outside the panel, where nothing takes them, the cursor says so. */}
    {rowDrag && !rowDrag.inPanel && !placing && <style>{"* { cursor: not-allowed !important; }"}</style>}
    {rowDrag && (
      <Flex align="center" gap="2" style={{ position: "fixed", left: rowDrag.x + 12, top: rowDrag.y + 12, pointerEvents: "none", zIndex: 1 }}>
        {entryAt(shelf, rowDrag.paths[0]) && isFolder(entryAt(shelf, rowDrag.paths[0])!) ? <ChevronRightIcon /> : <SnippetIcon />}
        <Text size="2">{rowDrag.paths.length > 1 ? `${rowDrag.paths.length} entries` : rowDrag.paths[0][rowDrag.paths[0].length - 1]}</Text>
      </Flex>
    )}
  </Flex>;
}
