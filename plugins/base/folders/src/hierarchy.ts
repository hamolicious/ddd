import type { CoreMap } from "@kernel";

export const CHILDREN_KEY = "children";

export interface NoteRow {
  readonly id: string;
  readonly title: string;
  readonly children: readonly string[];
}

export interface Hierarchy {
  readonly notes: ReadonlyMap<string, NoteRow>;
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  readonly parentOf: ReadonlyMap<string, string>;
  readonly roots: readonly string[];
}

export function readChildren(plugins: CoreMap | undefined, pluginId = "folders"): readonly string[] {
  const section = plugins?.[pluginId];
  if (section === null || typeof section !== "object" || Array.isArray(section)) return [];
  const raw = (section as CoreMap)[CHILDREN_KEY];
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw as readonly unknown[]) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (id !== "" && !out.includes(id)) out.push(id);
  }
  return out;
}

const byId = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

export function buildHierarchy(rows: readonly NoteRow[]): Hierarchy {
  const notes = new Map(rows.map((row) => [row.id, row]));
  const parentOf = new Map<string, string>();
  for (const row of [...rows].sort((a, b) => byId(a.id, b.id))) {
    for (const child of row.children) {
      if (child === row.id || !notes.has(child) || parentOf.has(child)) continue;
      parentOf.set(child, row.id);
    }
  }

  const reachable = new Set<string>();
  const childrenOf = (id: string): string[] =>
    (notes.get(id)?.children ?? []).filter((child) => parentOf.get(child) === id);
  const mark = (id: string): void => {
    const stack = [id];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (reachable.has(next)) continue;
      reachable.add(next);
      stack.push(...childrenOf(next));
    }
  };
  for (const row of rows) if (!parentOf.has(row.id)) mark(row.id);
  const stranded = rows.map((row) => row.id).filter((id) => !reachable.has(id)).sort(byId);
  for (const id of stranded) {
    if (reachable.has(id)) continue;
    const holder = rows
      .filter((row) => reachable.has(row.id) && row.id !== id && row.children.includes(id))
      .map((row) => row.id)
      .sort(byId)[0];
    if (holder === undefined) parentOf.delete(id);
    else parentOf.set(id, holder);
    mark(id);
  }

  const children = new Map<string, readonly string[]>();
  for (const row of rows) {
    const list = childrenOf(row.id);
    if (list.length > 0) children.set(row.id, list);
  }
  const roots = rows.map((row) => row.id).filter((id) => !parentOf.has(id)).sort(byId);
  return { notes, childrenOf: children, parentOf, roots };
}

export function ancestorsOf(hierarchy: Hierarchy, id: string): readonly string[] {
  const out: string[] = [];
  let current = hierarchy.parentOf.get(id);
  while (current !== undefined && !out.includes(current)) {
    out.push(current);
    current = hierarchy.parentOf.get(current);
  }
  return out;
}

export function isWithin(hierarchy: Hierarchy, candidate: string, ancestor: string): boolean {
  return candidate === ancestor || ancestorsOf(hierarchy, candidate).includes(ancestor);
}

export function titlePath(hierarchy: Hierarchy, id: string): readonly string[] {
  return [...ancestorsOf(hierarchy, id)]
    .reverse()
    .concat(id)
    .map((note) => hierarchy.notes.get(note)?.title ?? "Untitled");
}

export function descendantCount(hierarchy: Hierarchy, id: string): number {
  let count = 0;
  const stack = [...(hierarchy.childrenOf.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    count += 1;
    stack.push(...(hierarchy.childrenOf.get(next) ?? []));
  }
  return count;
}

export type ListWrite =
  | { readonly note: string; readonly action: "remove"; readonly id: string }
  | { readonly note: string; readonly action: "insert"; readonly id: string; readonly index: number }
  | { readonly note: string; readonly action: "push"; readonly id: string };

export function planMove(
  hierarchy: Hierarchy,
  id: string,
  parent: string,
  before?: string,
): readonly ListWrite[] {
  if (parent !== "" && isWithin(hierarchy, parent, id)) {
    throw new Error("A note cannot go inside itself.");
  }
  const holders = [...hierarchy.notes.values()]
    .filter((row) => row.children.includes(id))
    .map((row) => row.id);
  const current = hierarchy.parentOf.get(id) ?? "";

  if (parent === current && holders.length <= (parent === "" ? 0 : 1)) {
    if (parent === "" || before === id) return [];
    const raw = hierarchy.notes.get(parent)?.children ?? [];
    const without = raw.filter((child) => child !== id);
    const at = before === undefined ? without.length : without.indexOf(before);
    if (raw.indexOf(id) === at) return [];
    return [
      { note: parent, action: "remove", id },
      at >= without.length
        ? { note: parent, action: "push", id }
        : { note: parent, action: "insert", id, index: at },
    ];
  }

  const writes: ListWrite[] = [];
  if (parent !== "") {
    if (holders.includes(parent)) writes.push({ note: parent, action: "remove", id });
    const raw = (hierarchy.notes.get(parent)?.children ?? []).filter((child) => child !== id);
    const at = before === undefined ? -1 : raw.indexOf(before);
    writes.push(at < 0 ? { note: parent, action: "push", id } : { note: parent, action: "insert", id, index: at });
  }
  for (const holder of holders) {
    if (holder !== parent) writes.push({ note: holder, action: "remove", id });
  }
  return writes;
}
