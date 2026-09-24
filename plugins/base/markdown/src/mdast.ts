/**
 * The mdast shape this plugin reads, declared locally.
 *
 * Why not `@types/mdast`: the base distribution lives outside `web/` (SPEC §8 layout)
 * and node resolution from `plugins/base/**` never reaches `web/node_modules`. The
 * blessed runtime layer is wired up by explicit `paths` entries in `web/tsconfig.json`
 * — `unified`, `remark-parse`, `remark-gfm`, `remark-directive`, `react` — and
 * `mdast`/`unist` are not among them, by design: they are *type-only* packages, so a
 * `paths` entry for them would be a build-config change (frozen, `web/CONTRACTS.md`
 * rule 3) buying nothing a 40-line declaration does not.
 *
 * One permissive node type rather than a discriminated union, deliberately. The
 * renderer dispatches on `type` at runtime and `markdown.remark` contributions can put
 * *any* node type in the tree (SPEC §6.6, the escalated path), so a closed union would
 * be a lie the moment a plugin is installed. Every field is optional and every read is
 * guarded.
 */

export interface MdPoint {
  readonly line: number;
  readonly column: number;
  /** UTF-16 index into the parsed string. Present for everything remark produces. */
  readonly offset?: number;
}

export interface MdPosition {
  readonly start: MdPoint;
  readonly end: MdPoint;
}

export interface MdNode {
  readonly type: string;
  readonly children?: readonly MdNode[];
  readonly value?: string;
  readonly position?: MdPosition;
  readonly data?: {
    /** `mdast-util-directive` marks a container directive's `[label]` paragraph. */
    readonly directiveLabel?: boolean;
    readonly [key: string]: unknown;
  };

  // link / image / definition
  readonly url?: string;
  readonly title?: string | null;
  readonly alt?: string | null;

  // linkReference / imageReference / footnoteReference / definition
  readonly identifier?: string;
  readonly label?: string | null;
  readonly referenceType?: "shortcut" | "collapsed" | "full";

  // code
  readonly lang?: string | null;
  readonly meta?: string | null;

  // heading
  readonly depth?: number;

  // list / listItem
  readonly ordered?: boolean;
  readonly start?: number | null;
  readonly spread?: boolean;
  /** GFM task list items only: `[ ]`/`[x]`/`[X]`. Anything else stays literal text. */
  readonly checked?: boolean | null;

  // containerDirective / leafDirective / textDirective
  readonly name?: string;
  readonly attributes?: Readonly<Record<string, string | null | undefined>> | null;

  // table
  readonly align?: readonly (string | null)[] | null;
}

/** Span of a node in the parsed string, when remark recorded one. */
export function spanOf(node: MdNode): { start: number; end: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return { start, end };
}

/**
 * The node's own source text. This is how an *unregistered* directive degrades to
 * literal text (SPEC §6.6): remark has already consumed the `:::name` syntax, and the
 * only faithful way back to what the author typed is the slice it came from.
 */
export function sourceOf(node: MdNode, source: string): string | null {
  const span = spanOf(node);
  return span ? source.slice(span.start, span.end) : null;
}

/** Concatenate the `value`s of every text-ish descendant — a directive's label, say. */
export function textOf(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  if (!node.children) return "";
  let out = "";
  for (const child of node.children) out += textOf(child);
  return out;
}

/** Pre-order walk, document order. Used for task ordinals and definition collection. */
export function walk(node: MdNode, visit: (node: MdNode) => void): void {
  visit(node);
  if (!node.children) return;
  for (const child of node.children) walk(child, visit);
}
