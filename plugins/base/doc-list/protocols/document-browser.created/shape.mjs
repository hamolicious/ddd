import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/document-browser.created",
  version: "1.0.0",
  kind: "event",
  name: "DocumentCreated",
  description: `
A document was just created through \`lm/document-browser\` on this device. Sent once, after
the create went through and before it opens.`,
  shape: s.object({
    id: s.string(),
    parent: s.optional(s.string()).describe("The caller's \`parent\` hint, when it gave one."),
  }),
};
