import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/markdown.taskState",
  version: "1.0.0",
  kind: "slot",
  name: "MarkdownTaskState",
  key: "marker",
  description: `
A task marker. \`[ ]\` and \`[x]\` are markdown's own; a plugin may add \`[/]\`, \`[-]\`, \`[?]\`.
Marker meaning comes from the client, so a client without the providing plugin renders the
marker as literal text and can count tasks differently. States appear in the state menu in seat order.`,
  shape: s.object({
    marker: s.string().describe("The single character inside the brackets; `\" \"` for unchecked."),
    label: s.string(),
    icon: s.any().as("ReactNode"),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
    done: s.optional(s.boolean()).describe("`true` ⇒ counts as completed."),
  }),
};
