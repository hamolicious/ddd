/**
 * The mode registry: the types a mode is written against, and the registry
 * `addMode` fills.
 *
 * A mode is a way of showing one document. Read and Edit are symmetric: the surface owns
 * the route and the modes, and has no built-in favourite. Modes are listed by `order`, and
 * the first one whose `when` accepts the document is the default, unless a mode's `prefer`
 * claims the document, which outranks the user's default mode for that document.
 */

import type { ComponentType, ReactNode } from "react";

import { createRegistry, s, type DocumentId, type DocumentRow, type OpenDocument } from "@kernel";

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
  /**
   * Drawn inside another note (an embed), not on its own page. Show the content and leave
   * out the controls for changing how it is shown: the reader is reading the other note.
   */
  readonly embedded?: boolean;
}

export interface DocumentMode {
  readonly id: string;
  readonly label: string;
  readonly component: ComponentType<DocumentModeProps>;
  readonly icon?: ReactNode;
  /** Position in the mode switch; lower first. Default 100. */
  readonly order?: number;
  /** Whether the mode applies to this document; `false`: no tab, no place in the switch, never the default. Asked again whenever the row changes. One that throws hides its mode and is reported. Absent: every document. */
  readonly when?: (row: DocumentRow) => boolean;
  /** Whether this document should open in this mode rather than in the user's default mode — a canvas plugin claiming its canvas notes, say. The user's own switch on the document still wins. Several claimants: the first in order. Asked again whenever the row changes. One that throws claims nothing and is reported. */
  readonly prefer?: (row: DocumentRow) => boolean;
  /** Open a document just created on this device in this mode, whatever the user's default — an editor, so a new note is ready to type into. Only for that first showing; several: the first in order. */
  readonly forNew?: boolean;
}

export const modeRegistry = createRegistry<DocumentMode>({
  key: (mode) => mode.id,
  order: (mode) => mode.order ?? 100,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    component: s.component(),
    icon: s.optional(s.any()),
    order: s.optional(s.number()),
    when: s.optional(s.func()),
    prefer: s.optional(s.func()),
    forNew: s.optional(s.boolean()),
  }),
});
