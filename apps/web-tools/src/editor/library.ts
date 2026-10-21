import { generators, type Clip } from "./model";
import { readClip } from "./file";
import presetsFile from "./presets.json";

/** A saved advanced-editor document: its points, at least two, and generator regions, timed from its first point at 0. */
export interface Snippet extends Clip {
  name: string;
}

/** A folder of the snippet library, with its folders and snippets. */
export interface Folder {
  folder: string;
  items: Entry[];
}

/** A row of the snippet library; its name is unique in its folder, among folders and snippets alike. */
export type Entry = Folder | Snippet;
export const isFolder = (e: Entry): e is Folder => "folder" in e;
export const entryName = (e: Entry) => (isFolder(e) ? e.folder : e.name);

/** The snippet library as it is kept and exported. */
export interface LibraryFile {
  ossmRsWebTools: { version: 1; snippets: Entry[] };
}

/** Whether the entry at `path`, by its folders' and its own name, is `folder` or in it. */
export const under = (path: string[], folder: string[]) => folder.length <= path.length && folder.every((n, i) => path[i] === n);

/** The entries in the folder at `path` of `lib`; none when it is not there. */
export const itemsAt = (lib: Entry[], path: string[]) => path.reduce<Entry[]>((items, name) => items.find((e): e is Folder => isFolder(e) && e.folder === name)?.items ?? [], lib);

/** The entry at `path` of `lib`. */
export const entryAt = (lib: Entry[], path: string[]) => itemsAt(lib, path.slice(0, -1)).find((e) => entryName(e) === path[path.length - 1]);

/** `lib` with the entries in the folder at `path` changed by `f`. */
export const updatedAt = (lib: Entry[], path: string[], f: (items: Entry[]) => Entry[]): Entry[] =>
  path.length ? lib.map((e) => (isFolder(e) && e.folder === path[0] ? { ...e, items: updatedAt(e.items, path.slice(1), f) } : e)) : f(lib);

/** `items` with `incoming` merged in: a folder into the one of the same name, but a preset, the rest under a free name, " (2)" on. */
export function merged(items: Entry[], incoming: Entry[]): Entry[] {
  return incoming.reduce((list, e) => {
    const same = isFolder(e) && list.find((o): o is Folder => isFolder(o) && o.folder === e.folder && !PRESETS.includes(o));
    if (same && isFolder(e)) return list.map((o) => (o === same ? { ...same, items: merged(same.items, e.items) } : o));
    let name = entryName(e);
    for (let k = 2; list.some((o) => entryName(o) === name); k++) name = `${entryName(e)} (${k})`;
    return [...list, isFolder(e) ? { folder: name, items: merged([], e.items) } : { ...e, name }];
  }, items);
}

/** The entries of `items` whose names have `q` in them, ignoring case: a folder with all it holds, else with those in it that do. */
export const matching = (items: Entry[], q: string): Entry[] => items.flatMap((e) => {
  if (entryName(e).toLowerCase().includes(q.toLowerCase())) return [e];
  const inner = isFolder(e) ? matching(e.items, q) : [];
  return inner.length ? [{ ...e, items: inner } as Folder] : [];
});

/** Folders first, then snippets, each by name. */
export const sortedEntries = (items: Entry[]) => [...items].sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || entryName(a).localeCompare(entryName(b)));

/** The snippet library's entries in `list`, from an imported file; malformed ones go: without a name, or a snippet without two points. */
export function readEntries(list: unknown): Entry[] {
  return (Array.isArray(list) ? list : []).flatMap((e): Entry[] => {
    if (typeof e?.folder === "string" && e.folder.trim() && Array.isArray(e.items)) return [{ folder: e.folder, items: readEntries(e.items) }];
    const clip = typeof e?.name === "string" && e.name.trim() ? readClip(e.actions, e.regions) : null;
    // Its instances' contents only, as instances do not nest.
    return clip && clip.actions.length > 1 ? [{ name: e.name, actions: clip.actions, regions: generators(clip.regions) }] : [];
  });
}

/** The library's built-in entries, at its top level before the user's; they and all in them can't be changed, moved, or added to. */
export const PRESETS = readEntries(presetsFile.ossmRsWebTools.snippets);
export const isPreset = (path: string[]) => PRESETS.some((e) => entryName(e) === path[0]);
