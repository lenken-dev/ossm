/** A named time range, in ms, from `metadata.chapters`; other properties of the loaded one are kept. */
export interface Chapter {
  name: string;
  start: number;
  end: number;
  [other: string]: unknown;
}

/** A named time, in ms, from `metadata.bookmarks`; other properties of the loaded one are kept. */
export interface Bookmark {
  name: string;
  time: number;
  [other: string]: unknown;
}

export type Marker = Chapter | Bookmark;

/** Whether the marker `m` is a chapter, else a bookmark. */
export const isChapter = (m: Marker): m is Chapter => "start" in m;
/** Where the marker `m` is: a chapter's start, or a bookmark's time. */
export const timeOf = (m: Marker) => (isChapter(m) ? m.start : m.time);

/** A marker time from a file, in ms: ms as a number or `"HH:MM:SS.mmm"`; null when unusable. */
export function readTime(t: unknown) {
  const ms = typeof t === "number" ? t : typeof t === "string" && /^\d+(:\d+){0,2}(\.\d+)?$/.test(t) ? t.split(":").reduce((s, p) => s * 60 + Number(p), 0) * 1000 : NaN;
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
}

/** `ms` as `"HH:MM:SS.mmm"`, as markers are saved; the hours go past 24. */
export const writeTime = (ms: number) => `${String(Math.floor(ms / 3_600_000)).padStart(2, "0")}:${new Date(ms).toISOString().slice(14, 23)}`;

/** The chapters and bookmarks as a file's `metadata` has them, sorted. */
export const writeMarkers = (chapters: Chapter[], bookmarks: Bookmark[]) => ({
  chapters: [...chapters].sort((a, b) => a.start - b.start).map(({ start, end, ...rest }) => ({ ...rest, startTime: writeTime(start), endTime: writeTime(end) })),
  bookmarks: [...bookmarks].sort((a, b) => a.time - b.time).map(({ time, ...rest }) => ({ ...rest, time: writeTime(time) })),
});

/**
 * The chapters and bookmarks in `file`'s metadata, sorted. A chapter without an
 * end runs to the next one's start, the last to `end`; overlapping chapters are
 * cut where the later one starts.
 */
export function readMarkers(file: Record<string, unknown>, end: number) {
  const meta = (file.metadata ?? {}) as { chapters?: unknown; bookmarks?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((o): o is Record<string, unknown> => !!o && typeof o === "object") : []);
  const starts = list(meta.chapters)
    .map(({ startTime, endTime, ...rest }) => ({ rest, start: readTime(startTime), end: readTime(endTime) }))
    .filter((c): c is typeof c & { start: number } => c.start !== null)
    .sort((a, b) => a.start - b.start);
  const chapters: Chapter[] = starts
    .map((c, i) => {
      const next = starts[i + 1]?.start;
      const stop = c.end !== null && c.end > c.start ? c.end : next ?? Math.max(end, c.start + 1);
      return { ...c.rest, name: typeof c.rest.name === "string" ? c.rest.name : `Chapter ${i + 1}`, start: c.start, end: Math.min(stop, next ?? Infinity) };
    })
    .filter((c) => c.end > c.start);
  const bookmarks: Bookmark[] = list(meta.bookmarks)
    .map(({ time, ...rest }) => ({ ...rest, name: (typeof rest.name === "string" && rest.name) || "Bookmark", time: readTime(time) }))
    .filter((b): b is Bookmark => b.time !== null)
    .sort((a, b) => a.time - b.time);
  return { chapters, bookmarks };
}

/** Bookmark colours, Radix scales; a bookmark's name picks one, so bookmarks named alike match. */
export const MARKER_COLORS = ["blue", "green", "orange", "purple", "cyan", "crimson", "amber", "teal"];
export const markerColor = (name: string) => MARKER_COLORS[Math.abs([...name].reduce((h, c) => (h * 31 + c.codePointAt(0)!) | 0, 0)) % MARKER_COLORS.length];
/**
 * Which chapters are drawn light: those touching a dark one before them, so only
 * a run of touching chapters alternates; less than 100 ms apart counts as touching.
 */
export const lightChapters = (chapters: { start: number; end: number }[]) => {
  let lightBefore = false;
  return chapters.map((c, i) => (lightBefore = i > 0 && c.start - chapters[i - 1].end < 100 && !lightBefore));
};
