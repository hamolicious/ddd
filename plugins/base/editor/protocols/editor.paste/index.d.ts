/**
 * lm/editor.paste@1.0.0: slot, owned by `editor`.
 *
 * A paste and drop handler. The editor asks each one in seat order when something is
 * pasted or dropped onto it, and the first to return `true` takes it: the editor then does
 * nothing with it. `false` passes it on; when nobody takes it, CodeMirror handles it as
 * usual. `paste` must answer synchronously, since the browser's paste or drop is cancelled
 * in the same tick; slow work (an upload) starts here and finishes later through the
 * `EditorInsertion` it got from `insert`.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { DocumentId } from "@kernel";

/** The protocol this package describes. */
export type ProtocolId = "lm/editor.paste";
export type ProtocolVersion = "1.0.0";

export interface EditorPasteEvent {
  readonly documentId: DocumentId;
  /** A clipboard paste, or a drag dropped onto the text. */
  readonly via: "paste" | "drop";
  /** Files on the clipboard: a screenshot, or files copied in a file manager. */
  readonly files: readonly File[];
  /** The clipboard's plain text; empty when there is none. */
  readonly text: string;
  /**
   * Put text where it was going: a paste replaces the selection, a drop lands where it was
   * dropped. Every call inserts after the previous one, so several files land in order.
   */
  insert(text: string): EditorInsertion;
}

/**
 * Text a paste handler put in, followed through later edits. Anchored to the document, not
 * the editor, so it keeps working after the user leaves Edit mode.
 */
export interface EditorInsertion {
  /**
   * Swap the inserted text for `text`. `false`, changing nothing, when it has since been
   * edited or deleted: the user's change wins. This or `remove` settles the insertion; later
   * calls return `false`.
   */
  replace(text: string): boolean;
  /** Take the inserted text out again, under the same rule. */
  remove(): boolean;
}

export interface EditorPaste {
  readonly id: string;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
  readonly paste: (event: EditorPasteEvent) => boolean;
}
