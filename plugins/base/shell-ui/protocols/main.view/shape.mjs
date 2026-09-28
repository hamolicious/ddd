import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/main.view",
  version: "1.0.0",
  kind: "slot",
  name: "MainView",
  key: "id",
  description: `
A full-pane view, addressed by id. \`lm/router.route\` maps a URL to one of these, so a view
and its URL are provided independently: a view can be opened by the router, by a command, or
in a split.`,
  shape: s.object({
    id: s.string(),
    component: s.component().as("ComponentType<{ readonly params?: Readonly<Record<string, string>> }>"),
    title: s.optional(s.string()).describe("Shown in window and tab titles."),
  }),
};
