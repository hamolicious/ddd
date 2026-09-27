/**
 * Moves this client has written and the projection has not shown yet.
 *
 * Online, the projection learns about a splice only from the server's feed, and the
 * server materializes a document on a debounce (`MATERIALIZE_DEBOUNCE`, 500 ms) before
 * the feed carries it. For that second or so the tree drew the document in the folder
 * it had just been dragged out of — and a second drag in that window was planned
 * against the stale path, which `planDocumentMove` reads as "already there" and writes
 * nothing. So the tree draws the path it asked for, from the moment it asks, and stops
 * the moment the projection agrees.
 *
 * This is a *view* of the projection, never a second record of where a document lives:
 * an entry exists only between a write and its echo, and is dropped on failure or once
 * the projection says the same thing.
 */

import { normalizePath, type PathRow } from "./path.js";

/** `id → path` asked for; `""` is root. */
export type PendingPaths = ReadonlyMap<string, string>;

/** `rows` as they will be once every pending move has landed. */
export function withPendingPaths(rows: readonly PathRow[], pending: PendingPaths): readonly PathRow[] {
  if (pending.size === 0) return rows;
  return rows.map((row) => {
    const path = pending.get(row.id);
    if (path === undefined || normalizePath(row.fm["path"]) === path) return row;
    const { path: _old, ...rest } = row.fm;
    return { ...row, fm: path === "" ? rest : { ...rest, path } };
  });
}

/**
 * The pending entries the projection has caught up with, or can no longer confirm (the
 * document is gone from it): those are done, and the projection is the truth again.
 */
export function settledMoves(rows: readonly PathRow[], pending: PendingPaths): readonly string[] {
  if (pending.size === 0) return [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const settled: string[] = [];
  for (const [id, path] of pending) {
    const row = byId.get(id);
    if (!row || normalizePath(row.fm["path"]) === path) settled.push(id);
  }
  return settled;
}
