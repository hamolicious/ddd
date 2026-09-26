/**
 * The user's own order for folders.
 *
 * A folder is only a `path:` string, so it has no field to hold a position in. The order
 * is therefore **per-user bookkeeping in settings** (`folderOrder`), like `collapsedFolders`:
 * one list of folder paths. Siblings sort by where they appear in it; a folder the list
 * does not mention (new, or never dragged) comes after the ones it does, by name. The
 * list only matters *within* a parent, so a reorder rewrites that parent's siblings and
 * leaves the rest of the list where it was.
 *
 * Renaming or moving a folder carries its entry (and its descendants') along, so a
 * dragged-into-place folder keeps its place after a rename.
 */

import { isWithin, normalizePath } from "./path.js";

/** Sort key for a sibling: its index in the order, or after every listed one. */
export function rankOf(order: readonly string[], path: string): number {
  const index = order.indexOf(path);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

/**
 * `siblings` (as currently drawn) with `moved` placed before or after `target`.
 * `moved` need not be among them yet: a folder dropped next to a folder in another
 * parent joins that parent's list.
 */
export function placeAmong(
  siblings: readonly string[],
  moved: string,
  target: string,
  where: "before" | "after",
): string[] {
  const rest = siblings.filter((path) => path !== moved);
  const at = rest.indexOf(target);
  if (at < 0) return [...rest, moved];
  rest.splice(where === "before" ? at : at + 1, 0, moved);
  return rest;
}

/** The whole order with one parent's children replaced by `siblings`, in that order. */
export function withSiblings(
  order: readonly string[],
  siblings: readonly string[],
  replaced: readonly string[] = [],
): string[] {
  const drop = new Set([...siblings, ...replaced]);
  return [...order.filter((path) => !drop.has(path)), ...siblings];
}

/** `from` became `to`: carry its entry and every descendant's. */
export function renameInOrder(order: readonly string[], from: string, to: string): string[] {
  const source = normalizePath(from);
  const target = normalizePath(to);
  if (source === "" || source === target) return [...order];
  return order.map((path) =>
    path === source || isWithin(path, source) ? target + path.slice(source.length) : path,
  );
}

/** Only folders that still exist; a stale entry is harmless but the list never shrinks. */
export function pruneOrder(order: readonly string[], folders: ReadonlySet<string>): string[] {
  return order.filter((path) => folders.has(path));
}
