/**
 * The mode registry's pure logic, extracted so it can be unit-tested without a DOM,
 * a kernel or a React renderer.
 *
 * Everything here is a total function over plain data. The interesting rules — which
 * modes a document may show, which one wins, and how a per-document choice survives a
 * reload — are exactly the rules that are easiest to get wrong and hardest to notice,
 * because a wrong answer still renders *something*.
 *
 * `viewer` and `editor` are symmetric contributions (SPEC §6.5): nothing below names
 * either of them. {@link DEFAULT_MODE_ID} is a *fallback* string, used only when no
 * preference exists and `read` happens to be registered — if it is not, the
 * lowest-`order` visible mode wins, which is how a workspace that replaced both base
 * modes still opens a document.
 */

import type { DocumentRow } from "@kernel";

import type { DocumentMode } from "../../_shared/points.js";

/** The mode a fresh client prefers when nothing else says otherwise. */
export const DEFAULT_MODE_ID = "read";

/**
 * How many per-document mode choices are remembered. The memory is one settings
 * value — a YAML flow sequence in a settings document (SPEC §6.4) — so it is
 * deliberately small and deliberately lossy: it is a convenience, not state anything
 * depends on.
 */
export const MODE_MEMORY_CAP = 100;

/** `order` ascending; contributions without one sort as 100 (the registry default). */
export function byOrder(a: { readonly order?: number }, b: { readonly order?: number }): number {
  return (a.order ?? 100) - (b.order ?? 100);
}

export function sortModes(modes: readonly DocumentMode[]): readonly DocumentMode[] {
  return [...modes].sort(byOrder);
}

/**
 * The modes that may show this document, in order.
 *
 * A `when` predicate that **throws** hides its mode and reports it. Fail-closed is
 * the right direction here: a contribution whose own guard crashes cannot be trusted
 * to render, and the surface always has the other modes to fall back to. The
 * alternative — showing it anyway — trades a missing tab for a broken pane.
 */
export function visibleModes(
  modes: readonly DocumentMode[],
  row: DocumentRow | undefined,
  onError?: (mode: DocumentMode, error: unknown) => void,
): readonly DocumentMode[] {
  return sortModes(modes).filter((mode) => {
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

/**
 * Which mode to show, given the user's per-document choice, their default, and what
 * is actually registered and visible.
 *
 * Precedence: the document's remembered mode → the user's default → `read` →
 * the lowest-`order` visible mode. Every step is skipped when the named mode is not
 * visible, so an uninstalled `editor` degrades to reading rather than a blank pane.
 */
export function resolveModeId(
  remembered: string | undefined,
  preferred: string | undefined,
  visible: readonly DocumentMode[],
): string | undefined {
  const has = (id: string | undefined): boolean =>
    id !== undefined && visible.some((mode) => mode.id === id);
  if (has(remembered)) return remembered;
  if (has(preferred)) return preferred;
  if (has(DEFAULT_MODE_ID)) return DEFAULT_MODE_ID;
  // Sorted defensively: the surface passes `visibleModes()` output, but "the
  // lowest-`order` mode" must not quietly mean "whichever registered first".
  return sortModes(visible)[0]?.id;
}

/** The next mode in `order`, wrapping. `undefined` when nothing is registered. */
export function nextModeId(
  visible: readonly DocumentMode[],
  current: string | undefined,
): string | undefined {
  if (visible.length === 0) return undefined;
  const index = visible.findIndex((mode) => mode.id === current);
  return visible[(index + 1) % visible.length]?.id;
}

/**
 * Parse the remembered per-document modes out of a settings list.
 *
 * The stored form is one `"<document-id>=<mode-id>"` entry per document, because a
 * settings value is a flat YAML scalar or flow sequence (SPEC §6.4) — a nested map is
 * rejected by the settings surface, so the encoding is the price of storing this at
 * all. Insertion order is recency, oldest first.
 *
 * Total: an entry that is not a string, has no `=`, or has an empty half is dropped.
 */
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
    // A later entry for the same document wins and becomes the most recent.
    memory.delete(id);
    memory.set(id, mode);
  }
  return memory;
}

/** The settings-list form of {@link parseModeMemory}, capped to the most recent entries. */
export function serializeModeMemory(
  memory: ReadonlyMap<string, string>,
  cap: number = MODE_MEMORY_CAP,
): readonly string[] {
  const entries = [...memory.entries()].map(([id, mode]) => `${id}=${mode}`);
  return cap > 0 && entries.length > cap ? entries.slice(entries.length - cap) : entries;
}

/** Record a choice as the most recent one. Mutates and returns `memory`. */
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
