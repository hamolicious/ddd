import { buildHierarchy, type NoteRow } from "./hierarchy.js";

export interface PendingPlace {
  readonly parent: string;
  readonly before?: string;
}

export type PendingMoves = ReadonlyMap<string, PendingPlace>;

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
