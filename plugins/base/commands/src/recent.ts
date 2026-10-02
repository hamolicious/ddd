/**
 * The commands the user ran most recently, newest first, so the palette can put them on
 * top. Pure list handling here; `index.tsx` keeps it in `localStorage`.
 *
 * Per device, not in `kernel.settings`: a settings write is a document write that needs
 * the server, and this one happens on every command run.
 */

export const RECENT_LIMIT = 100;
export const RECENT_STORAGE_KEY = "ddd.commands.recent";

/** `id` moved to the front, without duplicates, at most {@link RECENT_LIMIT} long. */
export function pushRecent(recent: readonly string[], id: string): readonly string[] {
  return [id, ...recent.filter((entry) => entry !== id)].slice(0, RECENT_LIMIT);
}

/** A stored list, or `[]` for anything that is not a list of strings. */
export function parseRecent(raw: string | null | undefined): readonly string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const ids = value.filter((entry): entry is string => typeof entry === "string");
    return [...new Set(ids)].slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

/** id → position (0 is the most recent), for {@link rankMatches}. */
export function recencyIndex(recent: readonly string[]): ReadonlyMap<string, number> {
  return new Map(recent.map((id, index) => [id, index]));
}
