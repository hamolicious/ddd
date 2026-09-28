import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/syntax.language",
  version: "1.0.0",
  kind: "slot",
  name: "SyntaxLanguage",
  key: "id",
  description: `
A tree-sitter grammar code blocks can be highlighted with. Offered in Settings, Code
languages; nothing is downloaded until the user installs it. The URLs must be same-origin: a
plugin serves its grammars from its own \`frontend/\` directory. The grammar must be built for
the ABI of the \`web-tree-sitter\` that \`syntax-highlight\` bundles.`,
  shape: s.object({
    id: s.string().describe("Canonical name, lowercase: `rust`, `typescript`."),
    name: s.string().describe("Display name: `Rust`, `TypeScript`."),
    aliases: s.optional(s.array(s.string())).describe("Other info strings that mean this language: `rs`, `ts`."),
    wasmUrl: s.string(),
    highlightsUrl: s.string().describe("A tree-sitter `highlights.scm` query."),
    size: s.optional(s.number()).describe("Download size in bytes, shown before installing."),
  }),
};
