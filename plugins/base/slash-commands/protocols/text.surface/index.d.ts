/**
 * lm/text.surface@1.0.0: slot, owned by `slash-commands`.
 *
 * An editor, as anything that works at the caret sees it: the `/` menu, frontmatter
 * autocomplete. Editor-neutral on purpose: CodeMirror and a plain textarea both provide
 * one while mounted and withdraw it on unmount. One provider can feed several hosts.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { DocumentId } from "@kernel";
import type { EditorInsertion } from "@protocols/lm/editor.paste";

/** The protocol this package describes. */
export type ProtocolId = "lm/text.surface";
export type ProtocolVersion = "1.0.0";

/** A spot in a document to insert at later, anchored in the document rather than the editor. */
export interface TextMark {
  insert(text: string): EditorInsertion;
}

export interface TextSurface {
  /** Unique per mounted editor. */
  readonly id: string;
  readonly documentId: DocumentId;
  /** Where keys arrive. Capture-phase listeners here run before the editor's. */
  readonly element: HTMLElement;
  readonly hasFocus: () => boolean;
  readonly focus: () => void;
  /** The caret's line, from its start up to the caret. */
  readonly textBeforeCaret: () => string;
  /** The caret on screen, for placing a popup; `null` when it is not visible. */
  readonly caretRect: () => { readonly left: number; readonly top: number; readonly bottom: number } | null;
  /** Delete `length` characters before the caret, and mark the spot they were in. */
  readonly takeBeforeCaret: (length: number) => TextMark;
  /** Fires after every change to the text, the caret or focus. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The whole text up to the caret: what tells autocomplete the caret is in the frontmatter. */
  readonly documentBeforeCaret?: () => string;
  /** Replace `length` characters before the caret with `text`, leaving the caret after it. */
  readonly replaceBeforeCaret?: (length: number, text: string) => void;
}
