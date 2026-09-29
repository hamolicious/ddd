/**
 * The **render model** of the file tree: which rows the sidebar draws, in what order, at
 * what depth.
 *
 * `hierarchy.ts` answers "who is under whom"; this file answers what is on screen. Every
 * row is a note; one with children has a chevron.
 *
 * 1. **The root is a level, not a node.** Notes no one lists sit at depth 0.
 * 2. **Children keep their parent's order** (its `children` list, which drags rewrite).
 *    The root has no list, so its notes follow the user's own order (`rootOrder`, per
 *    user in settings; `order.ts`), then title, with a code-unit tiebreaker after
 *    `localeCompare` so two titles a collator calls equal still order the same on every
 *    platform.
 * 3. **A collapsed note contributes no descendant rows.** Collapse is the caller's
 *    state — persisted per user — so this function is pure and the visible tree is one
 *    call. The *negative* is stored, so a note nobody has touched is open.
 *
 * Every child is drawn, however many a note holds: the tree is a virtual list
 * (`_shared/virtual-list.ts`), so 400 rows cost what a screenful does.
 */

import type { Hierarchy } from "./hierarchy.js";
import { rankOf } from "./order.js";

export interface NoteTreeRow {
  readonly kind: "note";
  /** Stable row key. */
  readonly key: string;
  readonly id: string;
  readonly title: string;
  /** `""` at the root. */
  readonly parent: string;
  readonly depth: number;
  /** Notes anywhere below — what a collapsed row shows. */
  readonly descendants: number;
  readonly expandable: boolean;
  readonly expanded: boolean;
}

export type TreeRow = NoteTreeRow;

export interface FileTree {
  /** Depth-first, in draw order, collapsed subtrees omitted. */
  readonly rows: readonly TreeRow[];
  /** Each parent's children in draw order (`""` is the root): what a reorder places among. */
  readonly siblings: ReadonlyMap<string, readonly string[]>;
}

export interface FileTreeOptions {
  /** Collapsed note ids. */
  readonly collapsed?: ReadonlySet<string>;
  /** The user's order for root notes (`order.ts`): listed ones first, in list order. */
  readonly rootOrder?: readonly string[];
}

/** `localeCompare`, then code units, so the order never depends on the platform. */
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
    // Two unlisted notes are Infinity − Infinity = NaN apart: fall through to the title.
    if (byRank < 0 || byRank > 0) return byRank;
    return compareText(title(left), title(right)) || compareText(left, right);
  });

  const siblings = new Map<string, readonly string[]>([["", roots]]);
  for (const [parent, children] of hierarchy.childrenOf) siblings.set(parent, children);

  // Counted once per build, bottom-up: per row it would be quadratic on a deep tree.
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
