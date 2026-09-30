/**
 * What other plugins write against: the renderer's types, and the seven registries the
 * `add*` functions in `index.tsx` fill.
 *
 * The item shapes are checked when an item is added, so a malformed contribution fails
 * in the contributing plugin's `activate` rather than as a blank render later.
 */

import type { ComponentType, ReactNode } from "react";

import { createRegistry, s, type DocumentId, type Unsubscribe } from "@kernel";

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

/** Offsets of the three regions of one document text. */
export interface DocumentRegions {
  /** The frontmatter block including both `---` lines and the closing newline. */
  readonly frontmatter: TextSpan | null;
  /** The whole trailing `%%%` run. */
  readonly sections: TextSpan | null;
  /** What read mode renders: after the frontmatter, before the run. */
  readonly body: TextSpan;
}

export interface RenderAttachmentOptions {
  readonly placement: "inline" | "page";
  readonly alt?: string;
  readonly fallback: ReactNode;
}

export interface RenderOptions {
  readonly documentId?: string;
  /** Where `text[0]` sits in the document, for task clicks. Absent: `text` is the body. */
  readonly offset?: number;
}

/** The renderer functions as one type: the named exports of `plugin:markdown`. */
export interface MarkdownRenderer {
  /** Render a body to React. `offset` is where `text[0]` sits in the document, for task clicks. */
  readonly render: (text: string, options?: RenderOptions) => ReactNode;
  /** Strip the frontmatter and the `%%%` sections: what read mode shows. */
  readonly bodyOf: (text: string) => string;
  readonly regions: (text: string) => DocumentRegions;
  /** The task states added, in menu order. */
  readonly taskStates: () => readonly MarkdownTaskState[];
  /** An attachment as the winning renderer draws it, or `undefined` when none is added. */
  readonly renderAttachment: (attachmentId: string, options: RenderAttachmentOptions) => ReactNode | undefined;
  /** Turn an embedded `attachment://` into a wrapper document, filed where "Files go to" says when `folders` is enabled. */
  readonly promoteToDocument: (attachmentId: string) => Promise<string>;
  /** A link to a document as the body draws `[](doc://…)`: its live title, colour and icon; a click opens it. */
  readonly renderDocLink: (documentId: string) => ReactNode;
  /** Fires when a markdown contribution changes, so a cached render can re-render. */
  readonly onChange: (listener: () => void) => Unsubscribe;
}

// ---------------------------------------------------------------------------
// Contributions
// ---------------------------------------------------------------------------

export interface MarkdownAttachmentProps {
  /** The attachment's ULID. */
  readonly id: string;
  /** The embed's alt text, when it has one. */
  readonly alt?: string;
  /** `inline`: in the flow of a document. `page`: the whole view. */
  readonly placement: "inline" | "page";
  /**
   * What markdown would have drawn. Render it when this renderer has nothing better: no
   * viewer for the type, or the file could not be loaded.
   */
  readonly fallback: ReactNode;
  /**
   * Wrap what this renderer draws in the caller's file actions (download, promote). Not for
   * `fallback`, which carries its own.
   */
  readonly frame: (content: ReactNode) => ReactNode;
}

/**
 * What an embedded file (`![name](attachment://<ulid>)`) renders as. The first in order
 * wins; with none added, markdown draws its own inline image or chip. Also what the viewer
 * shows for a wrapper document, with `placement: "page"`.
 */
export interface MarkdownAttachment {
  readonly id: string;
  readonly component: ComponentType<MarkdownAttachmentProps>;
  /** Lower first; the first wins. Default 100. */
  readonly order?: number;
}

export interface MarkdownCodeBlockProps {
  readonly code: string;
  /** The info string's first word, as written (`ts`, `Rust`); absent when there is none. */
  readonly language?: string;
  readonly meta?: string;
  readonly documentId?: DocumentId;
}

/**
 * The renderer for a fenced code block no fence claims: ```rust, ```ts, or a fence with no
 * language. The first in order wins; with none added, markdown draws its own `<pre>`.
 */
export interface MarkdownCodeBlock {
  readonly id: string;
  readonly component: ComponentType<MarkdownCodeBlockProps>;
  /** Lower first; the first wins. Default 100. */
  readonly order?: number;
}

/** Override the React component for one mdast node type (`link`, `heading`, `table`). */
export interface MarkdownComponent {
  readonly node: string;
  readonly component: ComponentType<Record<string, unknown>>;
  readonly order?: number;
}

export interface MarkdownDirectiveProps {
  readonly attributes: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly children?: ReactNode;
  readonly documentId?: DocumentId;
}

/**
 * A directive: `:::name` (container), `::name` (leaf), `:name[text]{attrs}` (inline).
 * Directives and fences are the blessed syntaxes: named, collision-free, and they degrade
 * to literal text when the plugin is absent.
 */
export interface MarkdownDirective {
  readonly name: string;
  readonly kind: "container" | "leaf" | "text";
  readonly component: ComponentType<MarkdownDirectiveProps>;
}

export interface MarkdownFenceProps {
  readonly code: string;
  readonly meta?: string;
  readonly documentId?: DocumentId;
}

/** A renderer for a fenced code block of one language (```mermaid, ```chart). */
export interface MarkdownFence {
  readonly language: string;
  readonly component: ComponentType<MarkdownFenceProps>;
}

/**
 * A raw remark/unified plugin: the escalated path. It can change the meaning of the whole
 * document, so it is the last resort, not the first. Plugins run in `order`.
 */
export interface MarkdownRemark {
  readonly id: string;
  /** A unified `Pluggable`, typed loosely so this API does not pin unified's types. */
  readonly plugin: unknown;
  readonly options?: unknown;
  readonly order?: number;
}

/**
 * A task marker. `[ ]` and `[x]` are markdown's own; a plugin may add `[/]`, `[-]`, `[?]`.
 * A client without the adding plugin renders the marker as literal text. States appear in
 * the state menu in `order` (markdown's own are 0 and 10).
 */
export interface MarkdownTaskState {
  /** The single character inside the brackets; `" "` for unchecked. */
  readonly marker: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** Position in the state menu; lower first. Default 100. */
  readonly order?: number;
  /** `true` ⇒ counts as completed. */
  readonly done?: boolean;
}

// ---------------------------------------------------------------------------
// The registries
// ---------------------------------------------------------------------------

const orderOr100 = (item: { readonly order?: number }): number => item.order ?? 100;

export const attachmentRegistry = createRegistry<MarkdownAttachment>({
  key: (item) => item.id,
  order: orderOr100,
  shape: s.object({ id: s.string(), component: s.component(), order: s.optional(s.number()) }),
});

export const codeBlockRegistry = createRegistry<MarkdownCodeBlock>({
  key: (item) => item.id,
  order: orderOr100,
  shape: s.object({ id: s.string(), component: s.component(), order: s.optional(s.number()) }),
});

export const componentRegistry = createRegistry<MarkdownComponent>({
  key: (item) => item.node,
  order: orderOr100,
  shape: s.object({ node: s.string(), component: s.component(), order: s.optional(s.number()) }),
});

export const directiveRegistry = createRegistry<MarkdownDirective>({
  key: (item) => `${item.kind}:${item.name}`,
  shape: s.object({ name: s.string(), kind: s.literal("container", "leaf", "text"), component: s.component() }),
});

export const fenceRegistry = createRegistry<MarkdownFence>({
  key: (item) => item.language,
  shape: s.object({ language: s.string(), component: s.component() }),
});

export const remarkRegistry = createRegistry<MarkdownRemark>({
  key: (item) => item.id,
  order: orderOr100,
  shape: s.object({ id: s.string(), plugin: s.any(), options: s.optional(s.any()), order: s.optional(s.number()) }),
});

export const taskStateRegistry = createRegistry<MarkdownTaskState>({
  key: (item) => item.marker,
  order: orderOr100,
  shape: s.object({
    marker: s.string(),
    label: s.string(),
    icon: s.any(),
    order: s.optional(s.number()),
    done: s.optional(s.boolean()),
  }),
});
