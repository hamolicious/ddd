export const RECENT_LIMIT = 100;
export const RECENT_STORAGE_KEY = "ddd.commands.recent";

export function pushRecent(recent: readonly string[], id: string): readonly string[] {
  return [id, ...recent.filter((entry) => entry !== id)].slice(0, RECENT_LIMIT);
}

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

export function recencyIndex(recent: readonly string[]): ReadonlyMap<string, number> {
  return new Map(recent.map((id, index) => [id, index]));
}
