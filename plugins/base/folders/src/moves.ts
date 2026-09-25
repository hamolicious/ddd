/**
 * What a move *is*, before anything is written.
 *
 * Every write this plugin performs is one `fm.path` splice (SPEC §3.3), so a move is
 * fully described by the list of `(document, new path)` pairs it will splice. Computing
 * that list first buys three things the UI needs and one the user needs:
 *
 * - a **total** to show progress against,
 * - a **refusal** before any write when the move is nonsense (a folder into itself),
 * - a list that can be **recomputed and re-run** after a partial failure — re-planning
 *   reads the live projection, so documents that already moved are simply not in the
 *   second plan. That is what makes a half-finished rename resumable without bookkeeping.
 * - and, for the reader of a diff: the path arithmetic is here, tested, rather than
 *   inline in a click handler.
 *
 * Collisions are deliberately **not** in the list of problems. Two folders with the same
 * path are the same folder — `fm.path` is a prefix, not a record — so dropping `a/notes`
 * into `b` when `b/notes` already exists merges them, and documents already in `b/notes`
 * are untouched because their path does not change.
 */

import { isWithin, normalizePath, renamedPath, type PathRow } from "./path.js";

/** One document's move: exactly one `setFrontmatterValue`/`removeFrontmatterKey` call. */
export interface MoveEntry {
  readonly id: string;
  readonly from: string;
  /** `""` means the `path` key is removed entirely — the document goes to root. */
  readonly next: string;
}

/**
 * Every document that moves when the folder `from` becomes `to`.
 *
 * Documents whose path does not change are absent, not present-with-no-op: a splice that
 * writes the same value is still a CRDT transaction and still a sync round trip.
 */
export function planFolderMove(
  rows: readonly PathRow[],
  from: string,
  to: string,
): readonly MoveEntry[] {
  const source = normalizePath(from);
  if (source === "") return [];
  const entries: MoveEntry[] = [];
  for (const row of rows) {
    const current = normalizePath(row.fm["path"]);
    const next = renamedPath(current, source, to);
    if (next !== undefined) entries.push({ id: row.id, from: current, next });
  }
  return entries;
}

/** The documents a folder holds, directly or below it — the delete flow's subject. */
export function documentsUnder(rows: readonly PathRow[], folder: string): readonly string[] {
  const target = normalizePath(folder);
  if (target === "") return [];
  return rows
    .filter((row) => isWithin(normalizePath(row.fm["path"]), target))
    .map((row) => row.id);
}

/**
 * The path a document should get when it is dropped on `target`, or `undefined` when the
 * drop changes nothing (dropping a document into the folder it is already in).
 */
export function planDocumentMove(current: unknown, target: string): string | undefined {
  const now = normalizePath(current);
  const next = normalizePath(target);
  return now === next ? undefined : next;
}
