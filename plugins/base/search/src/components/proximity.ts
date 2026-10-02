export type ParentOf = (id: string) => string | undefined;

function chain(parentOf: ParentOf, id: string): readonly string[] {
  const ids = [id];
  const seen = new Set(ids);
  for (let at = id; at !== ""; ) {
    const parent = parentOf(at) ?? "";
    if (seen.has(parent)) break;
    ids.push(parent);
    seen.add(parent);
    at = parent;
  }
  if (!seen.has("")) ids.push("");
  return ids;
}

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

export function byProximity<T extends { readonly id: string }>(items: readonly T[], parentOf: ParentOf, from: string): T[] {
  const distance = distanceFrom(parentOf, from);
  return items
    .map((item, order) => ({ item, order, near: distance(item.id) }))
    .sort((a, b) => a.near - b.near || a.order - b.order)
    .map(({ item }) => item);
}
