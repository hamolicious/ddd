export const LINE_PARAM = "line";

export function lineFromPath(path: string): number | undefined {
  const at = path.indexOf("?");
  if (at < 0) return undefined;
  const raw = new URLSearchParams(path.slice(at + 1)).get(LINE_PARAM);
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const line = Number(raw);
  return Number.isSafeInteger(line) && line >= 1 ? line : undefined;
}
