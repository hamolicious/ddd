import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/commands.command",
  version: "2.0.0",
  kind: "slot",
  name: "Command",
  key: "id",
  description: `
A command: one id, one title, one function. The palette lists them; keybindings run them.
Two providers claiming one id: the lower seat wins and the other is reported.

A command with \`takes: "documents"\` acts on documents it is handed: its argument is the
ids, as \`readonly string[]\`. The document list's Actions button offers it for the
documents listed; the palette and keybindings, which have no documents to hand it, leave
it out.`,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    run: s.func().as("(argument?: unknown) => void | Promise<void>"),
    category: s.optional(s.string()).describe("Grouping in the palette."),
    icon: s.optional(s.string()).describe("An icon's name in `lm/icons` (Tabler), drawn beside the title."),
    takes: s
      .optional(s.literal("documents"))
      .describe("What the command acts on. `\"documents\"`: `run` gets `readonly string[]` of document ids."),
    when: s.optional(s.func().as("() => boolean")).describe("Return `false` to hide the command in the current context."),
  }),
};
