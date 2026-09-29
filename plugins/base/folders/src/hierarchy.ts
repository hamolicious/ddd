/**
 * Who is under whom, from the live projection.
 *
 * **A folder is a note.** Its children are listed, in order, in its own `%%% folders`
 * section under `children` (one id per line, so two devices filing into the same note at
 * once both land — `kernel.documents.splice.sectionList`). Any note can hold children;
 * one that holds none is a leaf. Nothing else records where a note lives: the parent is
 * whichever note lists it.
 *
 * The lists are written by people's devices concurrently and by hand, so this file reads
 * them defensively and fixes the three things they can say that a tree cannot:
 *
 * - **Two parents.** A move writes two notes (the old parent drops the id, the new one
 *   adds it); two devices moving one note at once can leave it in both. The parent with
 *   the smallest id keeps it — any fixed rule would do, as long as every device picks the
 *   same one — and the next move of that note removes it from every list but one.
 * - **A cycle.** A note listed under its own descendant is unreachable from the root. The
 *   smallest id in such a loop is cut loose and drawn at the root, so nothing disappears.
 * - **Unknown ids.** A child that is not in the projection (in Trash, purged, never
 *   synced, or machine-owned) is skipped, and kept in the list: restoring a note from
 *   Trash puts it back where it was.
 *
 * Pure: `index.tsx` decides when to write.
 */

import type { CoreMap } from "@kernel";

/** This plugin's section key for a note's children. */
export const CHILDREN_KEY = "children";

/** What the tree needs of a projection row. */
export interface NoteRow {
  readonly id: string;
  readonly title: string;
  /** The raw `children` list, de-duplicated, strings only, in order. */
  readonly children: readonly string[];
}

export interface Hierarchy {
  readonly notes: ReadonlyMap<string, NoteRow>;
  /** Each note's children as drawn: known, claimed by this note, in list order. */
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  /** A note's parent; absent at the root. */
  readonly parentOf: ReadonlyMap<string, string>;
  /** Notes at the root, in id order (the tree applies the user's order). */
  readonly roots: readonly string[];
}

/** `plugins.folders.children` of a projection row, as a clean list of ids. */
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
  // Smallest parent id first, so it is the one that keeps a note two lists claim.
  for (const row of [...rows].sort((a, b) => byId(a.id, b.id))) {
    for (const child of row.children) {
      if (child === row.id || !notes.has(child) || parentOf.has(child)) continue;
      parentOf.set(child, row.id);
    }
  }

  // Cut every cycle at its smallest id. Anything not reachable from a root is in one
  // (every note has at most one parent, so an unreachable note's ancestors loop).
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
    // Another list that is reachable may name it too: that parent wins over the root.
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

/** Every ancestor of `id`, nearest first. */
export function ancestorsOf(hierarchy: Hierarchy, id: string): readonly string[] {
  const out: string[] = [];
  let current = hierarchy.parentOf.get(id);
  while (current !== undefined && !out.includes(current)) {
    out.push(current);
    current = hierarchy.parentOf.get(current);
  }
  return out;
}

/** Is `candidate` the note `ancestor` or somewhere under it? */
export function isWithin(hierarchy: Hierarchy, candidate: string, ancestor: string): boolean {
  return candidate === ancestor || ancestorsOf(hierarchy, candidate).includes(ancestor);
}

/** The titles from the root down to `id`, for a picker: `["Home", "Lists", "Groceries"]`. */
export function titlePath(hierarchy: Hierarchy, id: string): readonly string[] {
  return [...ancestorsOf(hierarchy, id)]
    .reverse()
    .concat(id)
    .map((note) => hierarchy.notes.get(note)?.title ?? "Untitled");
}

/** How many notes sit anywhere under `id`. */
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

/** One list action on one note's `children`, as `index.tsx` will write it. */
export type ListWrite =
  | { readonly note: string; readonly action: "remove"; readonly id: string }
  | { readonly note: string; readonly action: "insert"; readonly id: string; readonly index: number }
  | { readonly note: string; readonly action: "push"; readonly id: string };

/**
 * The list writes that put `id` under `parent` (`""`: the root), before its child
 * `before`, or last when `before` is not given (or not one of its children).
 *
 * - The new parent is written **first**, so an interruption between the two writes leaves
 *   the note in two lists (drawn once, repaired by the next move) rather than in none.
 * - Every *other* list that names the note drops it — the repair for two parents.
 * - Moving within one parent is a remove and an insert on the same note. The insert's
 *   index counts the list as it will be after the remove, and in the raw list rather than
 *   the drawn one (ids the tree skips still hold places).
 * - `[]` when nothing would change.
 *
 * Throws when `parent` is the note itself or inside it.
 */
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
    // Same parent, no stray copies: a reorder, or nothing at all.
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
