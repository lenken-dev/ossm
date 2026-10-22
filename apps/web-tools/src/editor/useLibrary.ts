import { useEffect, useRef, useState, type Dispatch, type PointerEvent, type RefObject, type SetStateAction } from "react";
import { usePersistedState } from "../hooks/usePersistedState";
import { toggled } from "../funscript/model";
import { download } from "./file";
import { clipBy, generators, instanceOf, type Clip } from "./model";
import { entryAt, entryName, isFolder, isPreset, itemsAt, merged, PRESETS, readEntries, under, updatedAt, type Entry, type LibraryFile, type Snippet } from "./library";

/** The snippet library, its edits, and the Snippets panel's open folders, row selection and drags. */
export interface Library {
  /** The snippet library, shared by all scripts. */
  library: Entry[];
  /** Put back the snippet library `library`, as the undo history has it. */
  restore(library: Entry[]): void;
  /** The library as it shows: the presets, then the user's entries. */
  shelf: Entry[];
  /** The library's open folders, by their paths as JSON. */
  openFolders: string[];
  setOpenFolders: Dispatch<SetStateAction<string[]>>;
  /**
   * The library row being dragged, by its path, with the pointer, and the
   * folder it would go into, by its path as JSON. Pointer events, not native
   * drag and drop, so Shift and Ctrl still work over the graph (Wayland
   * browsers don't report them during a native drag).
   */
  rowDrag: { paths: string[][]; x: number; y: number; inPanel: boolean } | null;
  dropOn: string | null;
  /** The library's selected rows, by their paths as JSON, to move together. */
  rowsPicked: Set<string>;
  /** The library snippet at `path` as the advanced editor opens it: from `zero`, in whole ms; empty when it is gone. */
  snippetFrom(path: string[] | null, zero: number): Clip;
  /** Whether the folder at `folder` has an entry named `name`. */
  nameTaken(folder: string[], name: string): boolean;
  /** Save `clip` to the library as the snippet at `path`, timed from its first point, in place of one there. */
  saveSnippet(path: string[], clip: Clip): void;
  /**
   * Insert the library snippet `s` in place of what is being placed: it
   * follows the pointer until placed, as a paste, or while its row is dragged
   * until dropped on the graph; in the main script as an instance, in the
   * advanced editor as its points and regions. Not while a tool is open.
   */
  insertSnippet(s: Snippet): void;
  /** Add an empty folder `name` at the top level. */
  addFolder(name: string): void;
  renameEntry(path: string[], name: string): void;
  /** Delete the entry at `path`, a folder with its contents. */
  deleteEntry(path: string[]): void;
  /** A library row or the panel's top area as a place to drop the dragged rows into the folder at `to`, the top level for none; only in the main script. */
  dropInto(to: string[]): { onPointerMove?: () => void; onPointerLeave?: () => void; onPointerUp?: () => void };
  /**
   * Drag the library row of `entry` at `at` once the pointer moves from where
   * it was pressed, with the other selected rows if it is one: they go into
   * a folder row they are released on, and a lone snippet follows the pointer
   * onto the graph, as a paste, until released there or elsewhere. In the
   * main script, a press with Ctrl/Cmd or Shift picks the row instead, and
   * a click selects only it.
   */
  dragRow(e: PointerEvent, at: string[], entry: Entry, shown: string[]): void;
  /** The library as a file: every snippet and folder. */
  exportLibrary(): void;
  /** Merge a library file into the library: folders of the same name merge, a taken name gets " (2)"; malformed entries go. */
  importLibrary(file: File): Promise<void>;
}

/**
 * The snippet library and its edits, each named in the undo history through
 * `editLabel`; in the `advanced` editor, rows are not selected nor moved,
 * and an open `tool` keeps a snippet from inserting. Inserting places with
 * `insert`, in place of what is being placed, null placing nothing; a dragged
 * snippet dropped where nothing takes it goes with `stopPlacing`. An import's
 * error goes to `setError`.
 */
export function useLibrary({ advanced, tool, editLabel, insert, stopPlacing, setError }: {
  advanced: boolean;
  tool: boolean;
  editLabel: RefObject<string | null>;
  insert: (clip: Clip | null) => void;
  stopPlacing: () => void;
  setError: (error: string | null) => void;
}): Library {
  /** The snippet library, shared by all scripts, as its file holds it. */
  const [libraryFile, setLibraryFile] = usePersistedState<LibraryFile>("ossm:editorSnippets", { ossmRsWebTools: { version: 1, snippets: [] } }, localStorage);
  const library = libraryFile.ossmRsWebTools.snippets;
  const shelf = [...PRESETS, ...library];
  /** Change the snippet library as an edit called `label`. */
  const setLibrary = (label: string, f: (lib: Entry[]) => Entry[]) => {
    editLabel.current = label;
    setLibraryFile((l) => ({ ossmRsWebTools: { version: 1, snippets: f(l.ossmRsWebTools.snippets) } }));
  };
  const [openFolders, setOpenFolders] = usePersistedState<string[]>("ossm:editorSnippetFolders", [], localStorage);
  const [rowDrag, setRowDrag] = useState<{ paths: string[][]; x: number; y: number; inPanel: boolean } | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  /** The library's selected rows, by their paths as JSON, to move together; and the last one clicked, which Shift selects from. */
  const [rowsPicked, setRowsPicked] = useState<Set<string>>(new Set());
  const rowAnchor = useRef<string | null>(null);
  // A press anywhere but on a library row drops the selection.
  useEffect(() => {
    if (!rowsPicked.size) return;
    const down = (e: globalThis.PointerEvent) => !(e.target as Element).closest?.("[data-library-row]") && setRowsPicked(new Set());
    // Capturing, as the graph's presses stop there.
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [rowsPicked]);
  const restore = (library: Entry[]) => setLibraryFile({ ossmRsWebTools: { version: 1, snippets: library } });
  const snippetFrom = (path: string[] | null, zero: number) => {
    const s = path && entryAt(library, path);
    return s && !isFolder(s) ? clipBy(s, zero) : { actions: [], regions: [] };
  };

  /** What the undo history calls the library entry at `path`. */
  const entryNoun = (path: string[]) => {
    const e = entryAt(library, path);
    return e && isFolder(e) ? "folder" : "snippet";
  };

  const nameTaken = (folder: string[], name: string) => itemsAt(shelf, folder).some((e) => entryName(e) === name);

  const saveSnippet = (path: string[], clip: Clip) => {
    const name = path[path.length - 1];
    const snippet: Snippet = { name, ...clipBy(clip, -clip.actions[0].at) };
    setLibrary(`Save snippet "${name}"`, (lib) => updatedAt(lib, path.slice(0, -1), (items) => [...items.filter((e) => entryName(e) !== name), snippet]));
  };

  const insertSnippet = (s: Snippet) => insert(tool ? null : { actions: s.actions, regions: advanced ? generators(s.regions) : [instanceOf(s.name, s)] });

  /** The open folders at `from` and in it, now at `to`. */
  const reopened = (from: string[], to: string[]) => setOpenFolders((keys) => keys.map((k) => {
    const p = JSON.parse(k) as string[];
    return under(p, from) ? JSON.stringify([...to, ...p.slice(from.length)]) : k;
  }));

  const addFolder = (name: string) => setLibrary(`Add folder "${name}"`, (lib) => [...lib, { folder: name, items: [] }]);

  const renameEntry = (path: string[], name: string) => {
    const old = path[path.length - 1];
    setLibrary(`Rename ${entryNoun(path)} "${old}" to "${name}"`, (lib) => updatedAt(lib, path.slice(0, -1), (items) => items.map((e) => (entryName(e) !== old ? e : isFolder(e) ? { ...e, folder: name } : { ...e, name }))));
    reopened(path, [...path.slice(0, -1), name]);
  };

  const deleteEntry = (path: string[]) => {
    const name = path[path.length - 1];
    setLibrary(`Delete ${entryNoun(path)} "${name}"`, (lib) => updatedAt(lib, path.slice(0, -1), (items) => items.filter((o) => entryName(o) !== name)));
  };

  /** Of the entries at `from`, those not in the folder at `to` already. */
  const outside = (from: string[][], to: string[]) => from.filter((p) => JSON.stringify(p.slice(0, -1)) !== JSON.stringify(to));

  /** Whether the entries at `from` may go into the folder at `to`: not all there already, none into itself, none onto a name taken there or by another of them, and no preset nor into one. */
  const movable = (from: string[][], to: string[]) => {
    const names = outside(from, to).map((p) => p[p.length - 1]);
    return !!names.length && !isPreset(to) && !from.some(isPreset) && new Set(names).size === names.length && from.every((p) => !under(to, p)) && !names.some((n) => nameTaken(to, n));
  };

  /** Move the entries at `from` into the folder at `to`, the ones there already staying; selected there after. */
  const moveEntries = (from: string[][], to: string[]) => {
    const going = outside(from, to);
    const where = to.length ? `into "${to[to.length - 1]}"` : "to the top";
    setLibrary(going.length === 1 ? `Move ${entryNoun(going[0])} "${going[0][going[0].length - 1]}" ${where}` : `Move ${going.length} entries ${where}`, (lib) => {
      const es = going.map((p) => entryAt(lib, p)!);
      const left = going.reduce((l, p, k) => updatedAt(l, p.slice(0, -1), (items) => items.filter((o) => o !== es[k])), lib);
      return updatedAt(left, to, (items) => [...items, ...es]);
    });
    going.forEach((p) => reopened(p, [...to, p[p.length - 1]]));
    setRowsPicked(new Set(from.map((p) => JSON.stringify([...to, p[p.length - 1]]))));
  };

  const dropInto = (to: string[]) => advanced ? {} : {
    onPointerMove: () => rowDrag && movable(rowDrag.paths, to) && setDropOn(JSON.stringify(to)),
    onPointerLeave: () => setDropOn(null),
    onPointerUp: () => rowDrag && movable(rowDrag.paths, to) && moveEntries(rowDrag.paths, to),
  };

  /**
   * Pick the library row `key` clicked with a modifier: Ctrl/Cmd toggles it
   * in the selection, Shift selects the rows shown from the last clicked to
   * it, in `shown`, the rows shown by key in order.
   */
  const rowPicked = (e: PointerEvent, key: string, shown: string[]) => {
    if (e.shiftKey && rowAnchor.current && shown.includes(rowAnchor.current)) {
      const [i, j] = [shown.indexOf(rowAnchor.current), shown.indexOf(key)];
      return setRowsPicked(new Set(shown.slice(Math.min(i, j), Math.max(i, j) + 1)));
    }
    rowAnchor.current = key;
    setRowsPicked(toggled(key));
  };

  const dragRow = (e: PointerEvent, at: string[], entry: Entry, shown: string[]) => {
    if (e.button !== 0) return;
    const key = JSON.stringify(at);
    if (!advanced && (e.ctrlKey || e.metaKey || e.shiftKey)) return rowPicked(e, key, shown);
    // The selected entries still there, but those in a selected folder, which go with it.
    const picked = [...rowsPicked].map((k) => JSON.parse(k) as string[]).filter((p) => entryAt(shelf, p));
    const paths = !advanced && rowsPicked.has(key) ? picked.filter((p) => !picked.some((o) => o !== p && under(p, o))) : [at];
    if (!advanced && !rowsPicked.has(key)) setRowsPicked(new Set([key]));
    const [x, y] = [e.clientX, e.clientY];
    let started = false;
    const move = (m: globalThis.PointerEvent) => {
      if (!started && Math.hypot(m.clientX - x, m.clientY - y) < 4) return;
      if (!started) {
        if (paths.length === 1 && !isFolder(entry)) insertSnippet(entry);
        else insert(null);
      }
      started = true;
      setRowDrag({ paths, x: m.clientX, y: m.clientY, inPanel: !!(m.target as Element).closest?.("[data-aside]") });
    };
    // After the row or graph under the pointer has taken it.
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!started) {
        rowAnchor.current = key;
        if (!advanced) setRowsPicked(new Set([key]));
        return;
      }
      setRowDrag(null);
      setDropOn(null);
      stopPlacing();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const exportLibrary = () => download(libraryFile, "snippets.json");

  const importLibrary = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { ossmRsWebTools?: { snippets?: unknown } } | null;
      if (!Array.isArray(parsed?.ossmRsWebTools?.snippets)) throw new Error();
      const read = readEntries(parsed.ossmRsWebTools.snippets);
      // A top-level name of a preset goes on as " (2)".
      setLibrary(`Import ${file.name}`, (lib) => merged([...PRESETS, ...lib], read).slice(PRESETS.length));
      setError(null);
    } catch {
      setError(`${file.name} is not a snippet library.`);
    }
  };

  return { library, restore, shelf, openFolders, setOpenFolders, rowDrag, dropOn, rowsPicked, snippetFrom, nameTaken, saveSnippet, insertSnippet, addFolder, renameEntry, deleteEntry, dropInto, dragRow, exportLibrary, importLibrary };
}
