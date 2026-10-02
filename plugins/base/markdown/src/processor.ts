import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";

import type { MarkdownRemark } from "./api.js";

import type { MdNode } from "./mdast.js";

interface Pipeline {
  use(plugin: unknown, options?: unknown): Pipeline;
  parse(text: string): unknown;
  runSync(tree: unknown, file?: string): unknown;
}

export interface MarkdownProcessor {
  parse(text: string): MdNode;
}

export function buildProcessor(plugins: readonly MarkdownRemark[]): MarkdownProcessor {
  let pipeline = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(detachedTextDirectives) as unknown as Pipeline;

  for (const contribution of plugins) {
    pipeline = contribution.options === undefined
      ? pipeline.use(contribution.plugin)
      : pipeline.use(contribution.plugin, contribution.options);
  }

  return {
    parse: (text) => pipeline.runSync(pipeline.parse(text), text) as MdNode,
  };
}

const GLUED = /[\p{L}\p{N}_:]/u;

function detachedTextDirectives() {
  return (tree: MdNode, file: { value?: unknown }): void => {
    const source = typeof file.value === "string" ? file.value : "";
    if (source) fix(tree, source);
  };
}

function fix(node: MdNode, source: string): void {
  const children = node.children;
  if (!children) return;
  let changed = false;
  const out: MdNode[] = [];
  for (const child of children) {
    const start = child.position?.start.offset;
    const end = child.position?.end.offset;
    if (
      child.type === "textDirective" &&
      typeof start === "number" &&
      typeof end === "number" &&
      start > 0 &&
      GLUED.test(source[start - 1] ?? "")
    ) {
      changed = true;
      pushText(out, { type: "text", value: source.slice(start, end), position: child.position });
      continue;
    }
    fix(child, source);
    if (child.type === "text") pushText(out, child);
    else out.push(child);
  }
  if (changed) (node as { children?: readonly MdNode[] }).children = out;
}

function pushText(out: MdNode[], text: MdNode): void {
  const last = out[out.length - 1];
  if (last?.type !== "text") {
    out.push(text);
    return;
  }
  out[out.length - 1] = {
    ...last,
    value: `${last.value ?? ""}${text.value ?? ""}`,
    position:
      last.position && text.position ? { start: last.position.start, end: text.position.end } : undefined,
  };
}

export class ProcessorCache {
  private revision = -1;
  private processor: MarkdownProcessor | undefined;

  get(revision: number, plugins: () => readonly MarkdownRemark[]): MarkdownProcessor {
    if (this.processor && this.revision === revision) return this.processor;
    this.processor = buildProcessor(plugins());
    this.revision = revision;
    return this.processor;
  }
}
