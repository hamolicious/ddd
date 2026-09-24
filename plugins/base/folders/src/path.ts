/**
 * `fm.path` normalization and the tree derived from it.
 *
 * **There are no folder objects.** A folder is a prefix of the `fm.path` values that
 * happen to exist in the projection, computed on the fly — which is why moving a document
 * is one frontmatter splice and renaming a folder is one splice per document inside it.
 * Nothing here writes anything; it is the pure half, and it is pure so that the rules
 * SPEC §6.5 fixes can be pinned by tests rather than inferred from a tree widget.
 *
 * The rules, exactly as the SPEC states them:
 *
 * - `/` separates segments.
 * - `.`, `..` and empty segments are **stripped** — not resolved. `a/../b` is `a/b`, not
 *   `b`: `fm.path` is a label, not a filesystem path, and resolving `..` would let a
 *   document escape the folder a user just dropped it into.
 * - **Case-sensitive.** `Home` and `home` are two folders.
 * - **Duplicate names allowed**, because documents are id-addressed. Two `home/lists`
 *   folders cannot collide; two documents with the same title inside one can.
 *
 * One addition this file makes and the SPEC does not state: **segments are trimmed of
 * surrounding whitespace**. `home / lists` and `home/lists` are the same folder. Without
 * it a stray space produces a second folder that renders identically to the first, which
 * is indistinguishable from a bug from the user's side.
 */

/** A path segment must survive normalization to count. */
const DROPPED_SEGMENTS = new Set([".", ".."]);

/**
 * Normalize any `fm.path` value. Non-strings (a number, a list, a missing key) normalize
 * to `""`, which means "unfiled" — the projection is a shared workspace and a plugin
 * cannot assume a human typed what it expected.
 */
export function normalizePath(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && !DROPPED_SEGMENTS.has(segment))
    .join("/");
}

/** The segments of an already-normalized path. `""` has none. */
export function segmentsOf(path: string): readonly string[] {
  return path === "" ? [] : path.split("/");
}

/** The containing folder; `""` for a top-level folder. */
export function parentOf(path: string): string {
  const segments = segmentsOf(path);
  return segments.slice(0, -1).join("/");
}

/** The last segment — what a tree row shows. `""` for the unfiled root. */
export function nameOf(path: string): string {
  const segments = segmentsOf(path);
  return segments[segments.length - 1] ?? "";
}

/** Join and normalize in one step; every caller building a path uses this. */
export function joinPath(...parts: readonly string[]): string {
  return normalizePath(parts.join("/"));
}

/** Is `candidate` inside `ancestor` (or the same folder)? Both normalized. */
export function isWithin(candidate: string, ancestor: string): boolean {
  if (ancestor === "") return true;
  return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

export interface FolderNode {
  /** The full normalized path. */
  readonly path: string;
  /** The last segment, for display. */
  readonly name: string;
  /** 0 for a top-level folder. */
  readonly depth: number;
  /** Documents whose `fm.path` is exactly this folder. */
  readonly directDocuments: number;
  /** Documents in this folder or any descendant — what a collapsed row shows. */
  readonly documents: number;
  readonly children: readonly FolderNode[];
}

export interface FolderTree {
  readonly roots: readonly FolderNode[];
  /** Depth-first order, ready to render as a flat `tree` with `aria-level`. */
  readonly flat: readonly FolderNode[];
  /** Documents with no usable `fm.path`. */
  readonly unfiled: number;
  readonly totalDocuments: number;
}

/** Just enough of a projection row to build the tree from. */
export interface PathRow {
  readonly id: string;
  readonly fm: { readonly [key: string]: unknown };
}

/**
 * Build the tree from live projection rows.
 *
 * Ancestors are **implied**: a single document at `a/b/c` creates `a`, `a/b` and `a/b/c`,
 * because there is nowhere else for folder existence to come from. Sorting is
 * `localeCompare` within a level, with a code-unit tiebreaker so that two names a locale
 * considers equal (`Home` vs `home` in some collations) still order deterministically —
 * the tree is case-sensitive, so they are two rows and their order must not depend on the
 * platform's collator.
 */
export function buildTree(rows: readonly PathRow[]): FolderTree {
  const direct = new Map<string, number>();
  const subtree = new Map<string, number>();
  let unfiled = 0;

  for (const row of rows) {
    const path = normalizePath(row.fm["path"]);
    if (path === "") {
      unfiled += 1;
      continue;
    }
    direct.set(path, (direct.get(path) ?? 0) + 1);
    const segments = segmentsOf(path);
    for (let index = 1; index <= segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      subtree.set(prefix, (subtree.get(prefix) ?? 0) + 1);
      if (!direct.has(prefix)) direct.set(prefix, direct.get(prefix) ?? 0);
    }
  }

  const byParent = new Map<string, string[]>();
  for (const path of subtree.keys()) {
    const parent = parentOf(path);
    const siblings = byParent.get(parent) ?? [];
    siblings.push(path);
    byParent.set(parent, siblings);
  }

  const compare = (a: string, b: string): number => {
    const left = nameOf(a);
    const right = nameOf(b);
    const locale = left.localeCompare(right);
    if (locale !== 0) return locale;
    return left < right ? -1 : left > right ? 1 : 0;
  };

  const build = (path: string, depth: number): FolderNode => {
    const children = (byParent.get(path) ?? [])
      .sort(compare)
      .map((child) => build(child, depth + 1));
    return {
      path,
      name: nameOf(path),
      depth,
      directDocuments: direct.get(path) ?? 0,
      documents: subtree.get(path) ?? 0,
      children,
    };
  };

  const roots = (byParent.get("") ?? []).sort(compare).map((path) => build(path, 0));

  const flat: FolderNode[] = [];
  const walk = (nodes: readonly FolderNode[]): void => {
    for (const node of nodes) {
      flat.push(node);
      walk(node.children);
    }
  };
  walk(roots);

  return { roots, flat, unfiled, totalDocuments: rows.length };
}

/**
 * Where a document's path goes when the folder `from` is renamed to `to`.
 *
 * `undefined` means "this document is not affected". The prefix test is on whole
 * segments, so renaming `home` does not touch `homework`.
 */
export function renamedPath(path: string, from: string, to: string): string | undefined {
  const current = normalizePath(path);
  const source = normalizePath(from);
  const target = normalizePath(to);
  if (source === "" || !isWithin(current, source)) return undefined;
  const suffix = current.slice(source.length);
  const next = normalizePath(`${target}${suffix}`);
  return next === current ? undefined : next;
}

/** A rename that would put a folder inside itself, which must be refused, not clamped. */
export function isRecursiveRename(from: string, to: string): boolean {
  const source = normalizePath(from);
  const target = normalizePath(to);
  if (source === "" || target === "") return false;
  return target !== source && isWithin(target, source);
}
