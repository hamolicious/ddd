/**
 * The **render model** of the file tree: folders and documents in one ordered list.
 *
 * `path.ts` answers "what folders exist"; this file answers "what rows does the sidebar
 * draw, in what order, at what depth". They are separate because the second question has
 * an answer the first one does not need: a document is a *row* here, and a folder that
 * holds no document at all can still exist (see `extraFolders`).
 *
 * Three rules, and every one of them is a decision rather than an implementation detail:
 *
 * 1. **A document with no `fm.path` is a root row**, next to the top-level folders — not
 *    a separate "Unfiled" bucket at the foot of the panel. The owner's words: *"notes
 *    with no folder just sit in root"*. Root is not a node; it is the level everything
 *    starts at, which is why {@link buildFileTree} returns rows at depth 0 for both.
 * 2. **Folders first, then documents, each sorted within its level.** Folders sort by
 *    the user's own order (`order.ts`; unlisted ones after, by name) and documents by title, both with a code-unit tiebreaker after `localeCompare`
 *    so two names a collator calls equal (`Home` / `home`, which are two folders here)
 *    still order the same on every platform.
 * 3. **A folder that is not expanded contributes no descendant rows.** Expansion is the
 *    caller's state — persisted per user in `folders`' settings — so this function is
 *    pure and the whole visible tree is one call.
 *
 * The leaf cap is the fourth rule and the least obvious: a folder holding 400 documents
 * would otherwise put 400 rows in a sidebar that can show eight. Past
 * {@link DEFAULT_LEAF_LIMIT} the rest become one `more` row that opens the folder's own
 * view, where paging and filtering already live.
 */

import { rankOf } from "./order.js";
import { nameOf, normalizePath, parentOf, segmentsOf, type PathRow } from "./path.js";

/** Documents shown per folder before the rest collapse into one "more" row. */
export const DEFAULT_LEAF_LIMIT = 50;

/** A folder row. `path` is the full normalized path; `name` is its last segment. */
export interface FolderTreeRow {
  readonly kind: "folder";
  /** Stable row key, unique across kinds. */
  readonly key: string;
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  /** Documents in this folder and every descendant — what a collapsed row shows. */
  readonly documents: number;
  /** Documents whose `fm.path` is exactly this folder. */
  readonly directDocuments: number;
  /** `true` when the row has anything to expand (a subfolder or a document). */
  readonly expandable: boolean;
  readonly expanded: boolean;
  /** `true` while the folder exists only in settings (SPEC §3.3 has nothing to say yet). */
  readonly tracked: boolean;
}

/** A document row — a leaf. */
export interface DocumentTreeRow {
  readonly kind: "document";
  readonly key: string;
  readonly id: string;
  readonly title: string;
  /** The folder it sits in; `""` at root. */
  readonly path: string;
  readonly depth: number;
}

/** "…and 37 more" — the leaf cap, rendered as a row that opens the folder. */
export interface MoreTreeRow {
  readonly kind: "more";
  readonly key: string;
  readonly path: string;
  readonly hidden: number;
  readonly depth: number;
}

export type TreeRow = FolderTreeRow | DocumentTreeRow | MoreTreeRow;

export interface FileTree {
  /** Depth-first, in draw order, collapsed subtrees omitted. */
  readonly rows: readonly TreeRow[];
  /** Every folder that exists, derived and tracked alike, sorted by path. */
  readonly folders: readonly string[];
  /** Each parent's child folders in draw order (`""` is root): what a reorder rewrites. */
  readonly children: ReadonlyMap<string, readonly string[]>;
  /** Documents sitting at root (no usable `fm.path`). */
  readonly rootDocuments: number;
  readonly totalDocuments: number;
}

export interface FileTreeOptions {
  /**
   * Folders that exist without holding a document — the "new folder" bookkeeping kept in
   * this plugin's per-user settings until a first document lands (see `empty-folders.ts`).
   */
  readonly extraFolders?: readonly string[];
  /**
   * Collapsed folder paths — the *negative* is stored, so a folder nobody has touched
   * is open. A tree that starts shut hides the one thing the sidebar is for, and the
   * set that has to be remembered is then the whole workspace rather than the handful
   * of folders someone deliberately closed.
   */
  readonly collapsed?: ReadonlySet<string>;
  /** Documents drawn per folder before the rest become a "more" row. */
  readonly leafLimit?: number;
  /** The user's folder order (`order.ts`): listed folders first, in list order. */
  readonly order?: readonly string[];
}

/** `localeCompare`, then code units, so the order never depends on the platform. */
function compareText(left: string, right: string): number {
  const locale = left.localeCompare(right);
  if (locale !== 0) return locale;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Every folder a path implies: `a/b/c` implies `a`, `a/b`, `a/b/c`. */
function ancestry(path: string): readonly string[] {
  const segments = segmentsOf(path);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

export function buildFileTree(rows: readonly PathRow[], options: FileTreeOptions = {}): FileTree {
  const collapsed = options.collapsed ?? new Set<string>();
  const leafLimit = options.leafLimit ?? DEFAULT_LEAF_LIMIT;

  const direct = new Map<string, number>();
  const subtree = new Map<string, number>();
  const documentsIn = new Map<string, DocumentTreeRow[]>();
  const folders = new Set<string>();

  const note = (folder: string): void => {
    folders.add(folder);
    if (!direct.has(folder)) direct.set(folder, 0);
    if (!subtree.has(folder)) subtree.set(folder, 0);
  };

  for (const folder of options.extraFolders ?? []) {
    const path = normalizePath(folder);
    if (path === "") continue;
    for (const ancestor of ancestry(path)) note(ancestor);
  }

  for (const row of rows) {
    const path = normalizePath(row.fm["path"]);
    const leaf: DocumentTreeRow = {
      kind: "document",
      key: `d:${row.id}`,
      id: row.id,
      title: row.title ?? "Untitled",
      path,
      depth: 0, // rewritten when the row is placed
    };
    const bucket = documentsIn.get(path);
    if (bucket) bucket.push(leaf);
    else documentsIn.set(path, [leaf]);

    if (path === "") continue;
    direct.set(path, (direct.get(path) ?? 0) + 1);
    for (const ancestor of ancestry(path)) {
      note(ancestor);
      subtree.set(ancestor, (subtree.get(ancestor) ?? 0) + 1);
    }
  }

  const childFolders = new Map<string, string[]>();
  for (const folder of folders) {
    const parent = parentOf(folder);
    const siblings = childFolders.get(parent) ?? [];
    siblings.push(folder);
    childFolders.set(parent, siblings);
  }
  const order = options.order ?? [];
  for (const siblings of childFolders.values()) {
    siblings.sort((left, right) => {
      const byRank = rankOf(order, left) - rankOf(order, right);
      // Two unlisted folders are Infinity − Infinity = NaN apart: fall through to name.
      return byRank < 0 || byRank > 0 ? byRank : compareText(nameOf(left), nameOf(right));
    });
  }
  for (const bucket of documentsIn.values()) {
    bucket.sort((left, right) => {
      const byTitle = compareText(left.title, right.title);
      return byTitle !== 0 ? byTitle : compareText(left.id, right.id);
    });
  }

  const out: TreeRow[] = [];

  const emitLevel = (parent: string, depth: number): void => {
    for (const folder of childFolders.get(parent) ?? []) {
      const documents = subtree.get(folder) ?? 0;
      const children = (childFolders.get(folder) ?? []).length + (documentsIn.get(folder)?.length ?? 0);
      const isExpanded = !collapsed.has(folder);
      out.push({
        kind: "folder",
        key: `f:${folder}`,
        path: folder,
        name: nameOf(folder),
        depth,
        documents,
        directDocuments: direct.get(folder) ?? 0,
        expandable: children > 0,
        expanded: children > 0 && isExpanded,
        // A folder with no documents anywhere below it can only exist because somebody
        // asked for it — `extraFolders`, directly or as an implied ancestor of one.
        tracked: documents === 0,
      });
      if (children > 0 && isExpanded) emitLevel(folder, depth + 1);
    }

    const leaves = documentsIn.get(parent) ?? [];
    const shown = leaves.slice(0, leafLimit);
    for (const leaf of shown) out.push({ ...leaf, depth });
    if (leaves.length > shown.length) {
      out.push({
        kind: "more",
        key: `m:${parent}`,
        path: parent,
        hidden: leaves.length - shown.length,
        depth,
      });
    }
  };

  // Root is a level, not a node: top-level folders and pathless documents are both
  // drawn at depth 0 (the owner's "notes with no folder just sit in root").
  emitLevel("", 0);

  return {
    rows: out,
    folders: [...folders].sort(compareText),
    children: childFolders,
    rootDocuments: documentsIn.get("")?.length ?? 0,
    totalDocuments: rows.length,
  };
}

/** Every folder that must be expanded for `path` to be on screen. */
export function ancestorsOf(path: string): readonly string[] {
  return ancestry(normalizePath(path)).slice(0, -1);
}
