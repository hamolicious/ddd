import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/editor.paste",
  version: "1.0.0",
  kind: "slot",
  name: "EditorPaste",
  key: "id",
  description: `
A paste and drop handler. The editor asks each one in seat order when something is pasted or
dropped onto it, and the first to return \`true\` takes it. \`paste\` must answer synchronously,
since the browser's paste or drop is cancelled in the same tick; slow work (an upload) starts
here and finishes later through the \`EditorInsertion\` it got from \`insert\`.`,
  imports: `import type { DocumentId } from "@kernel";`,
  declarations: `
export interface EditorPasteEvent {
  readonly documentId: DocumentId;
  /** A clipboard paste, or a drag dropped onto the text. */
  readonly via: "paste" | "drop";
  /** Files on the clipboard: a screenshot, or files copied in a file manager. */
  readonly files: readonly File[];
  /** The clipboard's plain text; empty when there is none. */
  readonly text: string;
  /** Put text where it was going. Every call inserts after the previous one. */
  insert(text: string): EditorInsertion;
}

/**
 * Text a paste handler put in, followed through later edits. Anchored to the document, not
 * the editor, so it keeps working after the user leaves Edit mode.
 */
export interface EditorInsertion {
  /** Swap the inserted text for \`text\`; \`false\`, changing nothing, when it has since been edited. */
  replace(text: string): boolean;
  /** Take the inserted text out again, under the same rule. */
  remove(): boolean;
}`,
  shape: s.object({
    id: s.string(),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
    paste: s.func().as("(event: EditorPasteEvent) => boolean"),
  }),
};
