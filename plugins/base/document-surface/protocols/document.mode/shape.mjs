import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/document.mode",
  version: "1.0.0",
  kind: "slot",
  name: "DocumentMode",
  key: "id",
  description: `
A way of showing one document. Read and Edit are symmetric providers: the surface owns the
route and the modes, and has no built-in favourite. Modes are offered in seat order, and the
first one whose \`when\` accepts the document is the default.`,
  imports: `import type { DocumentId, DocumentRow, OpenDocument } from "@kernel";`,
  declarations: `
export interface DocumentModeProps {
  readonly id: DocumentId;
  readonly row: DocumentRow;
  /** Present once hydrated; read modes can render from \`row.content\` alone. */
  readonly open?: OpenDocument;
  /**
   * A 1-based line to reveal (\`#/doc/<id>?line=42\`). Best effort and the mode's own
   * business; a number past the end is clamped, never an error.
   */
  readonly line?: number;
  /** Set when the document cannot be opened for editing: show the text read-only instead. */
  readonly unavailable?: boolean;
}`,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    component: s.component().as("ComponentType<DocumentModeProps>"),
    icon: s.optional(s.any().as("ReactNode")),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
    when: s
      .optional(s.func().as("(row: DocumentRow) => boolean"))
      .describe("Whether the mode applies to this document; asked again whenever the row changes. Absent: every document."),
  }),
};
