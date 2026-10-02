import type { DocumentRow } from "@kernel";

import type { DocumentMode } from "./api.js";

export const DEFAULT_MODE_ID = "read";

export const MODE_MEMORY_CAP = 100;

export function visibleModes(
  modes: readonly DocumentMode[],
  row: DocumentRow | undefined,
  onError?: (mode: DocumentMode, error: unknown) => void,
): readonly DocumentMode[] {
  return modes.filter((mode) => {
    if (!mode.when) return true;
    if (!row) return true;
    try {
      return mode.when(row) !== false;
    } catch (error) {
      onError?.(mode, error);
      return false;
    }
  });
}

export function claimedModeId(
  visible: readonly DocumentMode[],
  row: DocumentRow | undefined,
  onError?: (mode: DocumentMode, error: unknown) => void,
): string | undefined {
  if (!row) return undefined;
  return visible.find((mode) => {
    if (!mode.prefer) return false;
    try {
      return mode.prefer(row) === true;
    } catch (error) {
      onError?.(mode, error);
      return false;
    }
  })?.id;
}

export function resolveModeId(
  remembered: string | undefined,
  preferred: string | undefined,
  visible: readonly DocumentMode[],
  claimed?: string,
): string | undefined {
  const has = (id: string | undefined): boolean =>
    id !== undefined && visible.some((mode) => mode.id === id);
  if (has(remembered)) return remembered;
  if (has(claimed)) return claimed;
  if (has(preferred)) return preferred;
  if (has(DEFAULT_MODE_ID)) return DEFAULT_MODE_ID;
  return visible[0]?.id;
}

export function nextModeId(
  visible: readonly DocumentMode[],
  current: string | undefined,
): string | undefined {
  if (visible.length === 0) return undefined;
  const index = visible.findIndex((mode) => mode.id === current);
  return visible[(index + 1) % visible.length]?.id;
}

export function parseModeMemory(entries: unknown): Map<string, string> {
  const memory = new Map<string, string>();
  if (!Array.isArray(entries)) return memory;
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const id = entry.slice(0, separator).trim();
    const mode = entry.slice(separator + 1).trim();
    if (id.length === 0 || mode.length === 0) continue;
    memory.delete(id);
    memory.set(id, mode);
  }
  return memory;
}

export function serializeModeMemory(
  memory: ReadonlyMap<string, string>,
  cap: number = MODE_MEMORY_CAP,
): readonly string[] {
  const entries = [...memory.entries()].map(([id, mode]) => `${id}=${mode}`);
  return cap > 0 && entries.length > cap ? entries.slice(entries.length - cap) : entries;
}

export function rememberMode(
  memory: Map<string, string>,
  documentId: string,
  modeId: string,
  cap: number = MODE_MEMORY_CAP,
): Map<string, string> {
  memory.delete(documentId);
  memory.set(documentId, modeId);
  while (cap > 0 && memory.size > cap) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memory.delete(oldest.value);
  }
  return memory;
}
