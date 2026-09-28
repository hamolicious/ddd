/**
 * lm/markdown-renderer@1.0.0: service, owned by `markdown`.
 *
 * The unified/remark to React pipeline: render a document's body, and the pieces around
 * it.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ReactNode } from "react";
import type { Unsubscribe } from "@kernel";
import type { MarkdownTaskState } from "@protocols/lm/markdown.taskState";

/** The protocol this package describes. */
export type ProtocolId = "lm/markdown-renderer";
export type ProtocolVersion = "1.0.0";

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

export interface MarkdownRenderer {
  /** Render a body to React. `offset` is where `text[0]` sits in the document, for task clicks. */
  readonly render: (text: string, options?: { readonly documentId?: string; readonly offset?: number }) => ReactNode;
  /** Strip the frontmatter and the `%%%` sections: what read mode shows. */
  readonly bodyOf: (text: string) => string;
  readonly regions: (text: string) => DocumentRegions;
  /** The task states wired in, in menu order. */
  readonly taskStates: () => readonly MarkdownTaskState[];
  /** An attachment as the winning renderer draws it, or `undefined` when none is wired. */
  readonly renderAttachment: (attachmentId: string, options: RenderAttachmentOptions) => ReactNode | undefined;
  /** Turn an embedded `attachment://` into a wrapper document. */
  readonly promoteToDocument: (attachmentId: string, options?: { readonly path?: string }) => Promise<string>;
  /** Fires when a markdown contribution changes, so a cached render can re-render. */
  readonly onChange: (listener: () => void) => Unsubscribe;
}
