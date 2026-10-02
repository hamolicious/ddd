export interface MdPoint {
  readonly line: number;
  readonly column: number;
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
    readonly directiveLabel?: boolean;
    readonly [key: string]: unknown;
  };

  readonly url?: string;
  readonly title?: string | null;
  readonly alt?: string | null;

  readonly identifier?: string;
  readonly label?: string | null;
  readonly referenceType?: "shortcut" | "collapsed" | "full";

  readonly lang?: string | null;
  readonly meta?: string | null;

  readonly depth?: number;

  readonly ordered?: boolean;
  readonly start?: number | null;
  readonly spread?: boolean;
  readonly checked?: boolean | null;

  readonly name?: string;
  readonly attributes?: Readonly<Record<string, string | null | undefined>> | null;

  readonly align?: readonly (string | null)[] | null;
}

export function spanOf(node: MdNode): { start: number; end: number } | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (typeof start !== "number" || typeof end !== "number") return null;
  return { start, end };
}

export function sourceOf(node: MdNode, source: string): string | null {
  const span = spanOf(node);
  return span ? source.slice(span.start, span.end) : null;
}

export function textOf(node: MdNode): string {
  if (typeof node.value === "string") return node.value;
  if (!node.children) return "";
  let out = "";
  for (const child of node.children) out += textOf(child);
  return out;
}

export function walk(node: MdNode, visit: (node: MdNode) => void): void {
  visit(node);
  if (!node.children) return;
  for (const child of node.children) walk(child, visit);
}
