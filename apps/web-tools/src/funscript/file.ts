/** A funscript's actions, sorted by time with duplicate timestamps dropped. */
export interface Funscript {
  name: string;
  /** Action times in ms */
  at: Uint32Array;
  /** Action positions, 0 (deep end) to 100 (shallow end) */
  pos: Float64Array;
}

const MAX_AT_MS = 0xffff_ffff;

/** localStorage key of the script the editor sends to the player, as a .funscript's JSON with its `name`. */
export const SENT_SCRIPT_KEY = "ossm:playerSent";
/** `window.name` of a tab showing the player, so the editor can switch to it. */
export const PLAYER_WINDOW = "ossm:player";

/** Parse a .funscript file. Throws an `Error` with a readable message. */
export function parseFunscript(name: string, text: string): Funscript {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  const actions = (json as { actions?: unknown } | null)?.actions;
  if (!Array.isArray(actions)) {
    throw new Error("No \"actions\" array found.");
  }

  const valid: { at: number; pos: number }[] = [];
  for (const action of actions) {
    const { at, pos } = (action ?? {}) as { at?: unknown; pos?: unknown };
    if (typeof at !== "number" || typeof pos !== "number") continue;
    if (!Number.isFinite(at) || !Number.isFinite(pos) || at < 0 || at > MAX_AT_MS) continue;
    valid.push({ at: Math.round(at), pos: Math.min(Math.max(pos, 0), 100) });
  }
  // Stable sort keeps the first of several actions sharing a timestamp.
  valid.sort((a, b) => a.at - b.at);
  const unique = valid.filter((a, i) => i === 0 || a.at !== valid[i - 1].at);
  if (unique.length < 2) {
    throw new Error("The script needs at least two actions with distinct times.");
  }

  return {
    name,
    at: Uint32Array.from(unique, (a) => a.at),
    pos: Float64Array.from(unique, (a) => a.pos),
  };
}

/** Read and parse a .funscript file. Rejects with an `Error` naming the file. */
export async function readFunscript(file: File): Promise<Funscript> {
  try {
    return parseFunscript(file.name, await file.text());
  } catch (e) {
    throw new Error(`${file.name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function funscriptDuration(script: Funscript): number {
  return (script.at[script.at.length - 1] - script.at[0]) / 1000;
}
