import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/markdown.component",
  version: "1.0.0",
  kind: "slot",
  name: "MarkdownComponent",
  key: "node",
  description: "Override the React component for one mdast node type (`link`, `heading`, `table`).",
  shape: s.object({
    node: s.string(),
    component: s.component().as("ComponentType<Record<string, unknown>>"),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
  }),
};
