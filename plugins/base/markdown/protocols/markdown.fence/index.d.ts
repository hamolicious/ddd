/**
 * lm/markdown.fence@1.0.0: slot, owned by `markdown`.
 *
 * A renderer for a fenced code block of one language (```mermaid, ```chart).
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType } from "react";
import type { DocumentId } from "@kernel";

/** The protocol this package describes. */
export type ProtocolId = "lm/markdown.fence";
export type ProtocolVersion = "1.0.0";

export interface MarkdownFenceProps {
  readonly code: string;
  readonly meta?: string;
  readonly documentId?: DocumentId;
}

export interface MarkdownFence {
  readonly language: string;
  readonly component: ComponentType<MarkdownFenceProps>;
}
