import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/commands.command",
  version: "1.0.0",
  kind: "slot",
  name: "Command",
  key: "id",
  description: `
A command: one id, one title, one function. The palette lists them; keybindings run them.
Two providers claiming one id: the lower seat wins and the other is reported.`,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    run: s.func().as("(argument?: unknown) => void | Promise<void>"),
    category: s.optional(s.string()).describe("Grouping in the palette."),
    icon: s.optional(s.any().as("ReactNode")),
    when: s.optional(s.func().as("() => boolean")).describe("Return `false` to hide the command in the current context."),
  }),
};
