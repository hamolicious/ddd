import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/altbar.panel",
  version: "1.0.0",
  kind: "slot",
  name: "AltbarPanel",
  key: "id",
  description: `
A panel in the altbar: the column opposite the sidebar, about whatever the main view is
showing (a document's history, the neighbourhood graph). The shell draws the ones whose
\`when\` accepts the current view; with none, the altbar and its toggle are absent.`,
  declarations: `
/** Which \`main.view\` is showing, and the route's params: what an altbar panel is about. */
export interface ShownView {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}`,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    component: s.component().as("ComponentType<{ readonly view: ShownView }>"),
    icon: s.optional(s.any().as("ReactNode")),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
    defaultOpen: s.optional(s.boolean()).describe("`true` ⇒ the panel starts expanded on first run. Default `true`."),
    when: s
      .optional(s.func().as("(view: ShownView) => boolean"))
      .describe("Whether this panel has anything to say about `view`. Default: every view."),
  }),
};
