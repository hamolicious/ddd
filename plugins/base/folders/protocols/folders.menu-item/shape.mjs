import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/folders.menu-item",
  version: "1.0.0",
  kind: "slot",
  name: "FolderMenuItem",
  key: "id",
  description: `
An entry in a folder's actions menu (the ⋯ button, right-click, long press), listed after the
tree's own entries and before "Delete folder", in seat order. \`run\` is called once the menu
has closed, so it may open a menu or sheet of its own.`,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    hint: s.optional(s.string()).describe("A second, quieter line under the label."),
    when: s.optional(s.func().as("(path: string) => boolean")).describe("Return `false` to leave the entry out for this folder."),
    run: s
      .func()
      .as("(path: string, anchor?: HTMLElement) => void")
      .describe("`path` is the folder's; `anchor` is the control that opened the menu, when there was one."),
  }),
};
