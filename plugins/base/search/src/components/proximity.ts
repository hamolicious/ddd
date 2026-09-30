/**
 * How near one note is to another in the folder tree: the steps up from `from` to the
 * nearest note above both, then down to `to`. The note itself is 0, its parent and its
 * children 1, its siblings 2. Every note shares the root (`""`), so every note has one.
 */

/** The note's parent, `""` at the root, `undefined` for a note the tree does not know. */
export type ParentOf = (id: string) => string | undefined;

/** `id`, then each note above it, up to and including the root. */
function chain(parentOf: ParentOf, id: string): readonly string[] {
  const ids = [id];
  const seen = new Set(ids);
  for (let at = id; at !== ""; ) {
    // A note the tree does not know sits at the root, as the tree draws it.
    const parent = parentOf(at) ?? "";
    if (seen.has(parent)) break;
    ids.push(parent);
    seen.add(parent);
    at = parent;
  }
  if (!seen.has("")) ids.push("");
  return ids;
}

/** A distance to `from` for any note, sharing the work of walking up from `from`. */
export function distanceFrom(parentOf: ParentOf, from: string): (to: string) => number {
  const above = new Map(chain(parentOf, from).map((id, steps) => [id, steps]));
  return (to) => {
    const up = chain(parentOf, to);
    for (let steps = 0; steps < up.length; steps += 1) {
      const shared = above.get(up[steps] as string);
      if (shared !== undefined) return steps + shared;
    }
    return Infinity;
  };
}

/** `items` nearest `from` first; ties keep their order. */
export function byProximity<T extends { readonly id: string }>(items: readonly T[], parentOf: ParentOf, from: string): T[] {
  const distance = distanceFrom(parentOf, from);
  return items
    .map((item, order) => ({ item, order, near: distance(item.id) }))
    .sort((a, b) => a.near - b.near || a.order - b.order)
    .map(({ item }) => item);
}
