import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/slash.command",
  version: "1.0.0",
  kind: "slot",
  name: "SlashCommand",
  key: "id",
  description: `
One entry in the \`/\` menu. Typing \`/att\` lists the commands whose title or keywords start with
it. With nothing typed, and among equally good matches, commands appear in seat order.`,
  imports: `import type { DocumentId } from "@kernel";

import type { TextMark } from "@protocols/lm/text.surface";`,
  declarations: `
export interface SlashCommandContext {
  readonly documentId: DocumentId;
  /** Where the \`/command\` was: insert here, now or after something slow. */
  readonly mark: TextMark;
  /** Give the editor its focus back. */
  focus(): void;
}`,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    description: s.optional(s.string()),
    icon: s.optional(s.any().as("ReactNode")),
    keywords: s.optional(s.array(s.string())).describe("Other words it is found by."),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
    when: s
      .optional(s.func().as("(context: { readonly documentId: DocumentId }) => boolean"))
      .describe("`false` ⇒ not offered in this document."),
    run: s
      .func()
      .as("(context: SlashCommandContext) => void")
      .describe(
        "Called with the typed `/command` removed, inside the key press or tap that chose it, so it may open a file picker or anything else that needs a user gesture.",
      ),
  }),
};
