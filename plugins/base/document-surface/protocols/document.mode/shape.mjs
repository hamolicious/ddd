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
}`,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    component: s.component().as("ComponentType<DocumentModeProps>"),
    icon: s.optional(s.any().as("ReactNode")),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
    when: s
      .optional(s.func().as("(row: DocumentRow) => boolean"))
      .describe(
        "Whether the mode applies to this document; `false`: no tab, no place in the switch, never the default. Asked again whenever the row changes. One that throws hides its mode and is reported. Absent: every document.",
      ),
  }),
};
