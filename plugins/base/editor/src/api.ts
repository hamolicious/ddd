import type { Extension } from "@codemirror/state";

import { createRegistry, s, type DocumentId } from "@kernel";

export interface EditorExtension {
  readonly id: string;
  readonly extension: Extension;
  readonly order?: number;
}

export interface EditorPasteEvent {
  readonly documentId: DocumentId;
  readonly via: "paste" | "drop";
  readonly files: readonly File[];
  readonly text: string;
  insert(text: string): EditorInsertion;
}

export interface EditorInsertion {
  replace(text: string): boolean;
  remove(): boolean;
}

export interface EditorPaste {
  readonly id: string;
  readonly order?: number;
  readonly paste: (event: EditorPasteEvent) => boolean;
}

export interface TextMark {
  insert(text: string): EditorInsertion;
}

export interface TextSurface {
  readonly id: string;
  readonly documentId: DocumentId;
  readonly element: HTMLElement;
  readonly hasFocus: () => boolean;
  readonly focus: () => void;
  readonly textBeforeCaret: () => string;
  readonly caretRect: () => { readonly left: number; readonly top: number; readonly bottom: number } | null;
  readonly takeBeforeCaret: (length: number) => TextMark;
  readonly subscribe: (listener: () => void) => () => void;
  readonly documentBeforeCaret?: () => string;
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
