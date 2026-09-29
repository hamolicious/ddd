/**
 * The user's own order for the notes at the root.
 *
 * A note's children are ordered by its own `children` list, which a drag rewrites. The
 * root has no note to hold a list, so its order is **per-user bookkeeping in settings**
 * (`rootOrder`), like `collapsedFolders`: a list of note ids. Root notes sort by where
 * they appear in it; one the list does not mention (new, or never dragged) comes after
 * the ones it does, by title.
 */

/** Sort key for a root note: its index in the order, or after every listed one. */
export function rankOf(order: readonly string[], id: string): number {
  const index = order.indexOf(id);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

/**
 * `siblings` (as currently drawn) with `moved` placed before or after `target`.
 * `moved` need not be among them yet: a note dropped next to a root note joins the root.
 */
export function placeAmong(
  siblings: readonly string[],
  moved: string,
  target: string,
  where: "before" | "after",
): string[] {
  const rest = siblings.filter((id) => id !== moved);
  const at = rest.indexOf(target);
  if (at < 0) return [...rest, moved];
  rest.splice(where === "before" ? at : at + 1, 0, moved);
  return rest;
}

/** Only notes that are still at the root; a stale entry is harmless but the list never shrinks. */
export function pruneOrder(order: readonly string[], roots: ReadonlySet<string>): string[] {
  return order.filter((id) => roots.has(id));
}
