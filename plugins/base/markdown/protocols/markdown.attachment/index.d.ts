/**
 * lm/markdown.attachment@1.0.0: slot, owned by `markdown`.
 *
 * What an embedded file (`![name](attachment://<ulid>)`) renders as. The first seat wins;
 * with none wired, markdown draws its own inline image or chip. Also what the viewer shows
 * for a wrapper document, with `placement: "page"`.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType, ReactNode } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/markdown.attachment";
export type ProtocolVersion = "1.0.0";

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

export interface MarkdownAttachment {
  readonly id: string;
  readonly component: ComponentType<MarkdownAttachmentProps>;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
}
