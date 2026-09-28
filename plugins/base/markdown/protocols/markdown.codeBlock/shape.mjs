import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/markdown.codeBlock",
  version: "1.0.0",
  kind: "slot",
  name: "MarkdownCodeBlock",
  key: "id",
  description: `
The renderer for a fenced code block no \`lm/markdown.fence\` claims: \`\`\`rust, \`\`\`ts, or a
fence with no language. The first seat wins; with none wired, markdown draws its own \`<pre>\`.`,
  imports: `import type { DocumentId } from "@kernel";`,
  declarations: `
export interface MarkdownCodeBlockProps {
  readonly code: string;
  /** The info string's first word, as written (\`ts\`, \`Rust\`). */
  readonly language?: string;
  readonly meta?: string;
  readonly documentId?: DocumentId;
}`,
  shape: s.object({
    id: s.string(),
    component: s.component().as("ComponentType<MarkdownCodeBlockProps>"),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
  }),
};
