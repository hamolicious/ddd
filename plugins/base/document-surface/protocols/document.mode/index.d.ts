/**
 * lm/document.mode@1.0.0: slot, owned by `document-surface`.
 *
 * A way of showing one document. Read and Edit are symmetric providers: the surface owns
 * the route and the modes, and has no built-in favourite. Modes are offered in seat order,
 * and the first one whose `when` accepts the document is the default.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType, ReactNode } from "react";
import type { DocumentId, DocumentRow, OpenDocument } from "@kernel";

/** The protocol this package describes. */
export type ProtocolId = "lm/document.mode";
export type ProtocolVersion = "1.0.0";

export interface DocumentModeProps {
  readonly id: DocumentId;
  readonly row: DocumentRow;
  /** Present once hydrated; read modes can render from `row.content` alone. */
  readonly open?: OpenDocument;
  /**
   * A 1-based line to reveal (`#/doc/<id>?line=42`). Best effort and the mode's own
   * business; a number past the end is clamped, never an error. A deep link, not a state:
   * the mode must render correctly without it.
   */
  readonly line?: number;
  /**
   * Set when the document cannot be opened for editing (offline and never opened on this
   * device, say). The surface has already said why; a mode that edits shows the text
   * read-only instead of waiting for a handle that is not coming.
   */
  readonly unavailable?: boolean;
}

export interface DocumentMode {
  readonly id: string;
  readonly label: string;
  readonly component: ComponentType<DocumentModeProps>;
  readonly icon?: ReactNode;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
  /** Whether the mode applies to this document; `false`: no tab, no place in the switch, never the default. Asked again whenever the row changes. One that throws hides its mode and is reported. Absent: every document. */
  readonly when?: (row: DocumentRow) => boolean;
}
