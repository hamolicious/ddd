/**
 * Moves this client has written and the projection has not shown yet.
 *
 * Online, the projection learns about a splice only from the server's feed, and the
 * server materializes a document on a debounce (`MATERIALIZE_DEBOUNCE`, 500 ms) before
 * the feed carries it. For that second or so the tree drew the note where it had just
 * been dragged out of — and a second drag in that window was planned against the stale
 * lists. So the tree draws the place it asked for, from the moment it asks, and stops the
 * moment the projection agrees.
 *
 * This is a *view* of the projection, never a second record of where a note lives: an
 * entry exists only between a write and its echo, and is dropped on failure or once the
 * projection says the same thing.
 */

import { buildHierarchy, type NoteRow } from "./hierarchy.js";

/** Where a note was asked to go: under `parent` (`""` is the root), before `before` or last. */
export interface PendingPlace {
  readonly parent: string;
  readonly before?: string;
}

export type PendingMoves = ReadonlyMap<string, PendingPlace>;

/** `rows` as they will be once every pending move has landed. */
export function withPendingMoves(rows: readonly NoteRow[], pending: PendingMoves): readonly NoteRow[] {
  if (pending.size === 0) return rows;
  const children = new Map(rows.map((row) => [row.id, [...row.children]]));
  for (const [id, place] of pending) {
    for (const list of children.values()) {
      const at = list.indexOf(id);
      if (at >= 0) list.splice(at, 1);
    }
    const target = children.get(place.parent);
    if (target === undefined) continue;
    const at = place.before === undefined ? -1 : target.indexOf(place.before);
    if (at < 0) target.push(id);
    else target.splice(at, 0, id);
  }
  return rows.map((row) => ({ ...row, children: children.get(row.id) ?? row.children }));
}

/**
 * The pending entries the projection has caught up with, or can no longer confirm (the
 * note is gone from it): those are done, and the projection is the truth again.
 */
export function settledMoves(rows: readonly NoteRow[], pending: PendingMoves): readonly string[] {
  if (pending.size === 0) return [];
  const hierarchy = buildHierarchy(rows);
  const settled: string[] = [];
  for (const [id, place] of pending) {
    if (!hierarchy.notes.has(id)) {
      settled.push(id);
      continue;
    }
    if ((hierarchy.parentOf.get(id) ?? "") !== place.parent) continue;
    if (place.before !== undefined && place.parent !== "") {
      const siblings = hierarchy.childrenOf.get(place.parent) ?? [];
      const at = siblings.indexOf(place.before);
      if (at >= 0 && siblings[at - 1] !== id) continue;
    }
    settled.push(id);
  }
  return settled;
}
