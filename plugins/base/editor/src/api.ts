/**
 * The editor's three registries and the types other plugins write against.
 *
 * - **Extensions** (`addExtension`): CodeMirror 6 extensions. The value is a
 *   `@codemirror/state` `Extension` from the shared copy, so replacing the editor means
 *   another CodeMirror-based editor. A plugin that adds markdown syntax should pair its
 *   renderer with an extension here, or the syntax is invisible while editing.
 * - **Paste handlers** (`addPasteHandler`): asked in order when something is pasted or
 *   dropped onto the editor; the first to return `true` takes it. `false` passes it on;
 *   when nobody takes it, CodeMirror handles it as usual. `paste` must answer
 *   synchronously, since the browser's paste or drop is cancelled in the same tick; slow
 *   work (an upload) starts there and finishes later through the `EditorInsertion` it got
 *   from `insert`.
 * - **Text surfaces** (`addSurface`): an editor, as anything that works at the caret sees
 *   it — the `/` menu, frontmatter autocomplete, emoji, wikilinks. Editor-neutral on
 *   purpose: CodeMirror and a plain textarea both add one while mounted and remove it on
 *   unmount.
 */

import type { Extension } from "@codemirror/state";

import { createRegistry, s, type DocumentId } from "@kernel";

export interface EditorExtension {
  readonly id: string;
  readonly extension: Extension;
  /** Lower first. Default 100. */
  readonly order?: number;
}

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
  /** Lower is asked first. Default 100. */
  readonly order?: number;
  readonly paste: (event: EditorPasteEvent) => boolean;
}

/**
 * A spot in a document to insert at later, anchored in the document rather than the editor.
 * Each insert lands after the previous one.
 */
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
  /** The whole text up to the caret: what tells autocomplete the caret is in the frontmatter. A surface without it still gets the `/` menu, and no autocomplete. */
  readonly documentBeforeCaret?: () => string;
  /** Replace `length` characters before the caret, never past the line start, with `text`, leaving the caret after it: choosing a suggestion. */
  readonly replaceBeforeCaret?: (length: number, text: string) => void;
}

export const extensionRegistry = createRegistry<EditorExtension>({
  key: (entry) => entry.id,
  order: (entry) => entry.order ?? 100,
  shape: s.object({
    id: s.string(),
    extension: s.any(),
    order: s.optional(s.number()),
  }),
});

export const pasteRegistry = createRegistry<EditorPaste>({
  key: (entry) => entry.id,
  order: (entry) => entry.order ?? 100,
  shape: s.object({
    id: s.string(),
    order: s.optional(s.number()),
    paste: s.func(),
  }),
});

export const surfaceRegistry = createRegistry<TextSurface>({
  key: (surface) => surface.id,
  shape: s.object({
    id: s.string(),
    documentId: s.string(),
    element: s.any(),
    hasFocus: s.func(),
    focus: s.func(),
    textBeforeCaret: s.func(),
    caretRect: s.func(),
    takeBeforeCaret: s.func(),
    subscribe: s.func(),
    documentBeforeCaret: s.optional(s.func()),
    replaceBeforeCaret: s.optional(s.func()),
  }),
});
