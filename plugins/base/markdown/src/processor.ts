/**
 * The unified/remark pipeline (SPEC §6.6), built **once per point revision**.
 *
 * `web/CONTRACTS.md`, area `base-markdown`: "Build the unified processor once per point
 * revision, not per render." A processor is not free to construct — `use()` walks and
 * freezes the plugin list — and `render()` is called on every React pass of every
 * document mode, so constructing one there is a per-keystroke cost in edit mode.
 *
 * The revision is bumped by the `markdown.remark` point's subscription and nothing else:
 * directive, fence, component and taskState contributions change how the *tree* is
 * rendered, not how it is parsed, so they must not invalidate the processor.
 *
 * **Three plugins, always, in this order.** `remark-parse` is the parser;
 * `remark-gfm` brings tables, strikethrough, autolinks, footnotes and GFM's three task
 * checkboxes; `remark-directive` brings `:::name` / `::name` / `:name[…]`, the blessed
 * extensible syntax. Contributed `markdown.remark` plugins are appended after them in
 * `order`, so a raw plugin can transform what the blessed syntaxes produced.
 *
 * **No `rehype`, no `raw`, no HTML.** The tree goes straight to React
 * (`render.tsx`), which is the structural reason "no raw-HTML passthrough in v1"
 * (SPEC §8) holds by construction rather than by sanitizer: there is no HTML stage to
 * pass anything through. `html` nodes reach the renderer and are printed as text.
 *
 * **Contributed plugins must be synchronous.** `render()` returns a `ReactNode`, so the
 * tree is produced with `runSync`; an async transformer throws there. That is the right
 * failure — an async remark plugin cannot work in a synchronous renderer, and finding
 * out at contribution time beats a half-rendered document.
 */

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkDirective from "remark-directive";

import type { MarkdownRemark } from "@protocols/lm/markdown.remark";

import type { MdNode } from "./mdast.js";

/**
 * The slice of unified's API this file uses.
 *
 * unified's generics re-type the processor on every `use()`, which cannot be expressed
 * by a `let` accumulating plugins in a loop. The contributed plugins are `unknown` at the
 * protocol anyway (`MarkdownRemark.plugin` is deliberately loose so `lm/markdown.remark`
 * does not pin unified's types), so the chain is built through this minimal structural
 * type.
 */
interface Pipeline {
  use(plugin: unknown, options?: unknown): Pipeline;
  parse(text: string): unknown;
  runSync(tree: unknown, file?: string): unknown;
}

export interface MarkdownProcessor {
  /** Markdown text → mdast, with every contributed remark plugin applied. */
  parse(text: string): MdNode;
}

export function buildProcessor(plugins: readonly MarkdownRemark[]): MarkdownProcessor {
  let pipeline = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkDirective)
    .use(detachedTextDirectives) as unknown as Pipeline;

  // In seat order, as the host hands them over (PLUGIN-PROTOCOLS §6a).
  for (const contribution of plugins) {
    // A contribution that is not a usable `Pluggable` throws here, at boot, naming the
    // plugin — not three documents later with an empty pane.
    pipeline = contribution.options === undefined
      ? pipeline.use(contribution.plugin)
      : pipeline.use(contribution.plugin, contribution.options);
  }

  return {
    // The text rides along as the vfile so `detachedTextDirectives` can look behind a node.
    parse: (text) => pipeline.runSync(pipeline.parse(text), text) as MdNode,
  };
}

/**
 * A text directive only counts when it starts a word: `a :emoji` is a directive,
 * `a:emoji` and `18:00` are not, and neither is the `:x` of `:tada:x`.
 *
 * `remark-directive` accepts `:name` anywhere, so times and `key:value` prose turned into
 * (unregistered, hence literal-chip) directives. Any `textDirective` whose source is
 * immediately preceded by a letter, digit, `_` or `:` is turned back into the text it came from,
 * merged with its text neighbours so the paragraph reads as one run.
 */
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

/** Append a text node, folding it into a preceding text node. */
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

/**
 * Cache one processor per revision of the `markdown.remark` point.
 *
 * Deliberately a one-entry cache: there is exactly one live revision, and keeping older
 * processors around would keep their plugins' closures alive for nothing.
 */
export class ProcessorCache {
  private revision = -1;
  private processor: MarkdownProcessor | undefined;

  /** The processor for `revision`, rebuilt only when the revision moved. */
  get(revision: number, plugins: () => readonly MarkdownRemark[]): MarkdownProcessor {
    if (this.processor && this.revision === revision) return this.processor;
    this.processor = buildProcessor(plugins());
    this.revision = revision;
    return this.processor;
  }
}
