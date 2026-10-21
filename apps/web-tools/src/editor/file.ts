import { clamp, type Action } from "../funscript/model";
import { isInstance, movedBy, type Clip, type Inner, type Region } from "./model";
import { SHAPES, type Func, type GenerateSetup, type RepeatKept } from "./generate";

/**
 * The regions in `list`, from a file's or the clipboard's `"ossmRsWebTools"`, sorted.
 * Lenient: one is left out, its points staying ordinary, when its times are
 * not numbers with From before To, or it has neither a setup that is an
 * object with a known timing and known shapes, a spline's with knots, a
 * Repeat setup with a pattern of two points or more, a Length and known
 * shapes, nor a snippet with a name; of overlapping ones, all but the first. An instance's
 * regions are read alike, those not inside it left out alone. A name that is
 * not text goes; other field values are not checked.
 */
export function readRegions(list: unknown): Region[] {
  const known = (f?: Func) => !!f && typeof f === "object" && Object.keys(SHAPES).includes(f.shape) && (f.shape !== "spline" || Array.isArray(f.knots));
  const read = (Array.isArray(list) ? list : []).flatMap((r): Region[] => {
    // A name that is not text goes, as if never given.
    if (typeof r?.name !== "string") r = { ...r, name: undefined };
    if (typeof r?.from !== "number" || typeof r.to !== "number" || !(r.from < r.to)) return [];
    const g = r.generate as GenerateSetup | undefined;
    if (!!g && typeof g === "object" && ["interval", "speed", "markers"].includes(g.timing) && known(g.interval) && known(g.speed) && known(g.out) && known(g.in)) return [r];
    const p = r.repeat as RepeatKept | undefined;
    const pattern = Array.isArray(p?.pattern) && p.pattern.every((a) => Number.isFinite(a?.at) && Number.isFinite(a?.pos)) ? p.pattern : [];
    if (pattern.length > 1 && typeof p?.length === "number" && known(p.time) && known(p.out) && known(p.in)) return [r];
    const snippet = r.snippet as { name?: unknown; regions?: unknown } | undefined;
    if (typeof snippet?.name !== "string") return [];
    // Not nested: an instance's own instances go.
    const inner = readRegions(snippet.regions).filter((i): i is Inner => !isInstance(i) && i.from >= r.from && i.to <= r.to);
    return [{ ...r, snippet: { ...snippet, name: snippet.name, regions: inner } }];
  });
  const regions: Region[] = [];
  for (const r of read.sort((a, b) => a.from - b.from)) if (!regions.length || r.from > regions[regions.length - 1].to) regions.push(r);
  return regions;
}

/**
 * Points from the clipboard or a file, with the regions they carry, timed
 * from the first point; null without any. Anything could be in them: points
 * without numbers go, the rest are sorted, in whole ms, one per ms, within
 * 0–100; the regions are read as `readRegions` does.
 */
export function readClip(actions: unknown, regions: unknown): Clip | null {
  if (!Array.isArray(actions)) return null;
  const valid = (actions as Partial<Action>[])
    .filter((a): a is Action => Number.isFinite(a?.at) && Number.isFinite(a?.pos))
    .sort((a, b) => a.at - b.at);
  if (!valid.length) return null;
  return {
    actions: valid
      .map((a) => ({ at: Math.round(a.at - valid[0].at), pos: clamp(a.pos, 0, 100) }))
      .filter((a, i, all) => i === 0 || a.at !== all[i - 1].at),
    regions: readRegions(regions).map((r) => movedBy(r, -valid[0].at)),
  };
}

/**
 * `data` as JSON, indented, but an object or array that holds none on one
 * line, as a point, so no line grows long with the script. Strings hold no
 * line breaks there, so a bracket ending a line opens one.
 */
const pretty = (data: unknown) => JSON.stringify(data, null, 2).replace(/[{[]\n(?:[^"{}[\]]|"(?:[^"\\]|\\.)*")*\n *[}\]]/g, (m) => JSON.stringify(JSON.parse(m)));

/** Download `data` as the JSON file `name`. */
export function download(data: unknown, name: string) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([pretty(data)], { type: "application/json" })), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}
