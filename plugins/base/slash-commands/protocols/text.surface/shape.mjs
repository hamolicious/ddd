import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/text.surface",
  version: "1.0.0",
  kind: "slot",
  name: "TextSurface",
  key: "id",
  description: `
An editor, as anything that works at the caret sees it: the \`/\` menu, frontmatter
autocomplete. Editor-neutral on purpose: CodeMirror and a plain textarea both provide one
while mounted and withdraw it on unmount. One provider can feed several hosts.`,
  imports: `import type { DocumentId } from "@kernel";

import type { EditorInsertion } from "@protocols/lm/editor.paste";`,
  declarations: `
/** A spot in a document to insert at later, anchored in the document rather than the editor. */
export interface TextMark {
  insert(text: string): EditorInsertion;
}`,
  shape: s.object({
    id: s.string().describe("Unique per mounted editor."),
    documentId: s.string().as("DocumentId"),
    element: s.any().as("HTMLElement").describe("Where keys arrive. Capture-phase listeners here run before the editor's."),
    hasFocus: s.func().as("() => boolean"),
    focus: s.func().as("() => void"),
    textBeforeCaret: s.func().as("() => string").describe("The caret's line, from its start up to the caret."),
    caretRect: s
      .func()
      .as("() => { readonly left: number; readonly top: number; readonly bottom: number } | null")
      .describe("The caret on screen, for placing a popup; `null` when it is not visible."),
    takeBeforeCaret: s
      .func()
      .as("(length: number) => TextMark")
      .describe("Delete `length` characters before the caret, and mark the spot they were in."),
    subscribe: s.func().as("(listener: () => void) => () => void").describe("Fires after every change to the text, the caret or focus."),
    documentBeforeCaret: s
      .optional(s.func().as("() => string"))
      .describe("The whole text up to the caret: what tells autocomplete the caret is in the frontmatter."),
    replaceBeforeCaret: s
      .optional(s.func().as("(length: number, text: string) => void"))
      .describe("Replace `length` characters before the caret with `text`, leaving the caret after it."),
  }),
};
