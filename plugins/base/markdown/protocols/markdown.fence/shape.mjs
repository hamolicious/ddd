import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/markdown.fence",
  version: "1.0.0",
  kind: "slot",
  name: "MarkdownFence",
  key: "language",
  description: "A renderer for a fenced code block of one language (```mermaid, ```chart).",
  imports: `import type { DocumentId } from "@kernel";`,
  declarations: `
export interface MarkdownFenceProps {
  readonly code: string;
  readonly meta?: string;
  readonly documentId?: DocumentId;
}`,
  shape: s.object({
    language: s.string(),
    component: s.component().as("ComponentType<MarkdownFenceProps>"),
  }),
};
