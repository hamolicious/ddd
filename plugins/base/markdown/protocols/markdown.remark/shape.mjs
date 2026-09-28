import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/markdown.remark",
  version: "1.0.0",
  kind: "slot",
  name: "MarkdownRemark",
  key: "id",
  description: `
A raw remark/unified plugin: the escalated path. It can change the meaning of the whole
document, so it is the last resort, not the first. Plugins run in seat order.`,
  shape: s.object({
    id: s.string(),
    plugin: s.any().describe("A unified `Pluggable`, typed loosely so the protocol does not pin unified's types."),
    options: s.optional(s.any()),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
  }),
};
