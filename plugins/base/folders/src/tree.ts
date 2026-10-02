import type { Hierarchy } from "./hierarchy.js";
import { rankOf } from "./order.js";

export interface NoteTreeRow {
  readonly kind: "note";
  readonly key: string;
  readonly id: string;
  readonly title: string;
  readonly parent: string;
  readonly depth: number;
  readonly descendants: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
}

export type TreeRow = NoteTreeRow;

export interface FileTree {
  readonly rows: readonly TreeRow[];
  readonly siblings: ReadonlyMap<string, readonly string[]>;
}

export interface FileTreeOptions {
  readonly collapsed?: ReadonlySet<string>;
  readonly rootOrder?: readonly string[];
}

export function compareText(left: string, right: string): number {
  const locale = left.localeCompare(right);
  if (locale !== 0) return locale;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildFileTree(hierarchy: Hierarchy, options: FileTreeOptions = {}): FileTree {
  const collapsed = options.collapsed ?? new Set<string>();
  const order = options.rootOrder ?? [];
  const title = (id: string): string => hierarchy.notes.get(id)?.title ?? "Untitled";

  const roots = [...hierarchy.roots].sort((left, right) => {
    const byRank = rankOf(order, left) - rankOf(order, right);
    if (byRank < 0 || byRank > 0) return byRank;
    return compareText(title(left), title(right)) || compareText(left, right);
  });

  const siblings = new Map<string, readonly string[]>([["", roots]]);
  for (const [parent, children] of hierarchy.childrenOf) siblings.set(parent, children);

  const counts = new Map<string, number>();
  const descendants = (id: string): number => {
    const known = counts.get(id);
    if (known !== undefined) return known;
    let count = 0;
    for (const child of hierarchy.childrenOf.get(id) ?? []) count += 1 + descendants(child);
    counts.set(id, count);
    return count;
  };

  const out: TreeRow[] = [];
  const emit = (parent: string, depth: number): void => {
    for (const id of siblings.get(parent) ?? []) {
      const expandable = (hierarchy.childrenOf.get(id)?.length ?? 0) > 0;
      const expanded = expandable && !collapsed.has(id);
      out.push({
        kind: "note",
        key: `n:${id}`,
        id,
        title: title(id),
        parent,
        depth,
        descendants: descendants(id),
        expandable,
        expanded,
      });
      if (expanded) emit(id, depth + 1);
    }
  };
  emit("", 0);

  return { rows: out, siblings };
}
