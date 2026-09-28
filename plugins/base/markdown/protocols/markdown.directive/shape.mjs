import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/markdown.directive",
  version: "1.0.0",
  kind: "slot",
  name: "MarkdownDirective",
  key: ["kind", "name"],
  description: `
A directive: \`:::name\` (container), \`::name\` (leaf), \`:name[text]{attrs}\` (inline).
Directives and fences are the blessed syntaxes: named, collision-free, and they degrade to
literal text when the plugin is absent.`,
  imports: `import type { DocumentId } from "@kernel";`,
  declarations: `
export interface MarkdownDirectiveProps {
  readonly attributes: Readonly<Record<string, string>>;
  readonly label?: string;
  readonly children?: ReactNode;
  readonly documentId?: DocumentId;
}`,
  shape: s.object({
    name: s.string(),
    kind: s.literal("container", "leaf", "text"),
    component: s.component().as("ComponentType<MarkdownDirectiveProps>"),
  }),
};
