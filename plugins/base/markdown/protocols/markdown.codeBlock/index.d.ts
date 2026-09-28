/**
 * lm/markdown.codeBlock@1.0.0: slot, owned by `markdown`.
 *
 * The renderer for a fenced code block no `lm/markdown.fence` claims: ```rust, ```ts, or a
 * fence with no language. The first seat wins; with none wired, markdown draws its own
 * `<pre>`. A fence for the block's language always goes first: this is the default for
 * code, not an override of fences.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType } from "react";
import type { DocumentId } from "@kernel";

/** The protocol this package describes. */
export type ProtocolId = "lm/markdown.codeBlock";
export type ProtocolVersion = "1.0.0";

export interface MarkdownCodeBlockProps {
  readonly code: string;
  /** The info string's first word, as written (`ts`, `Rust`); absent when there is none. */
  readonly language?: string;
  readonly meta?: string;
  readonly documentId?: DocumentId;
}

export interface MarkdownCodeBlock {
  readonly id: string;
  readonly component: ComponentType<MarkdownCodeBlockProps>;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
}
