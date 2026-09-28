import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/shell.overlay",
  version: "1.0.0",
  kind: "slot",
  name: "ShellOverlay",
  key: "id",
  description: `
A component that is always mounted, outside the header, sidebar and main region: a command
palette, a toast stack, a sheet. The shell holds the only \`kernel.ui.mount\`, so this is how
a plugin gets a persistent React presence that is not part of the layout. It should render
nothing until it has something to show, and anything modal should portal or position itself.`,
  shape: s.object({
    id: s.string(),
    component: s.component().as("ComponentType<Record<string, never>>"),
  }),
};
