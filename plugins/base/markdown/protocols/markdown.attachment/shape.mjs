import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/markdown.attachment",
  version: "1.0.0",
  kind: "slot",
  name: "MarkdownAttachment",
  key: "id",
  description: `
What an embedded file (\`![name](attachment://<ulid>)\`) renders as. The first seat wins; with
none wired, markdown draws its own inline image or chip. Also what the viewer shows for a
wrapper document, with \`placement: "page"\`.`,
  declarations: `
export interface MarkdownAttachmentProps {
  /** The attachment's ULID. */
  readonly id: string;
  /** The embed's alt text, when it has one. */
  readonly alt?: string;
  /** \`inline\`: in the flow of a document. \`page\`: the whole view. */
  readonly placement: "inline" | "page";
  /**
   * What markdown would have drawn. Render it when this renderer has nothing better: no
   * viewer for the type, or the file could not be loaded.
   */
  readonly fallback: ReactNode;
  /**
   * Wrap what this renderer draws in the caller's file actions (download, promote). Not for
   * \`fallback\`, which carries its own.
   */
  readonly frame: (content: ReactNode) => ReactNode;
}`,
  shape: s.object({
    id: s.string(),
    component: s.component().as("ComponentType<MarkdownAttachmentProps>"),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
  }),
};
