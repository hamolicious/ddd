import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/navbar.item",
  version: "1.0.0",
  kind: "slot",
  name: "NavbarItem",
  key: "id",
  description: `
One item in the top bar, placed in one of the header's two sides. \`component\` renders it;
\`onSelect\` is the shorthand for the common case, a button that runs a command.

A provider's items appear in its seat's order; the header's own "Top bar" setting lets each
person rearrange them on top of that.`,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    icon: s.optional(s.any().as("ReactNode")).describe("Any renderable node: an inline SVG, a character, a component's output."),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
    side: s
      .optional(s.literal("start", "end"))
      .describe("`start` sits after the sidebar toggle and grows; `end` is pushed right and never shrinks. Default `start`."),
    onSelect: s.optional(s.func().as("() => void")),
    component: s
      .optional(s.component().as("ComponentType<Record<string, never>>"))
      .describe("Takes over rendering entirely (the notice bell, the sync pill)."),
  }),
};
