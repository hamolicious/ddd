import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/editor.extension",
  version: "1.0.0",
  kind: "slot",
  name: "EditorExtension",
  key: "id",
  description: `
A CodeMirror 6 extension. This is the protocol that pins the runtime layer: the value is a
\`@codemirror/state\` \`Extension\` from the shared copy, so replacing the editor means another
CodeMirror-based editor. A plugin that adds markdown syntax should pair its renderer with an
extension here, or the syntax is invisible while editing.`,
  imports: `import type { Extension } from "@codemirror/state";`,
  shape: s.object({
    id: s.string(),
    extension: s.any().as("Extension"),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
  }),
};
