export function rankOf(order: readonly string[], id: string): number {
  const index = order.indexOf(id);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

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

export function pruneOrder(order: readonly string[], roots: ReadonlySet<string>): string[] {
  return order.filter((id) => roots.has(id));
}
