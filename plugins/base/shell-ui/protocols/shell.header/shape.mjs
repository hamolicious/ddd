import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/shell.header",
  version: "1.0.0",
  kind: "slot",
  name: "ShellHeader",
  key: "id",
  description: `
The spot above the sidebar and main region. A host shows one: \`shell-ui\` hosts it with
\`"seats": 1\`, so a new connection takes the seat and benches the previous header. The
component owns its whole row, \`<header>\` included.`,
  shape: s.object({
    id: s.string(),
    component: s.component().as("ComponentType<Record<string, never>>"),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
  }),
};
