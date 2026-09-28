import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/sidebar.panel",
  version: "1.0.0",
  kind: "slot",
  name: "SidebarPanel",
  key: "id",
  description: `
A panel in the sidebar (folders, the document list, an outline). Collapsible. Panels appear
top to bottom in seat order.`,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    component: s.component().as("ComponentType<Record<string, never>>"),
    icon: s.optional(s.any().as("ReactNode")),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
    defaultOpen: s.optional(s.boolean()).describe("`true` ⇒ the panel starts open on first run."),
  }),
};
