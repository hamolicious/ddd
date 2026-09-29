import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/commands",
  version: "1.0.0",
  kind: "service",
  name: "Commands",
  description: `
The command registry, for plugins that run commands rather than offer them: a list to
build a menu from, and a way to run one by id. \`when()\` is honoured by both.`,
  imports: `import type { Command } from "@protocols/lm/commands.command";`,
  shape: s.object({
    list: s.func().as("() => readonly Command[]").describe("Every command enabled right now, in seat order."),
    run: s
      .func()
      .as("(id: string, argument?: unknown) => Promise<void>")
      .describe("Run a command by id. Rejects for an unknown id; does nothing when its `when()` says no."),
    openPalette: s.func().as("(initialQuery?: string) => void"),
  }),
};
