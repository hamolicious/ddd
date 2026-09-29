import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/folders.decoration",
  version: "2.0.0",
  kind: "slot",
  name: "FolderDecoration",
  key: "id",
  description: `
Dresses note rows in the folder tree: a background, a text colour, an icon, in any
combination. The icon and the name are drawn together in a pill that takes \`background\`.
The tree asks \`decorate\` for every note it draws, by id, and redraws when \`onChange\`
fires. With several providers, each field comes from the first one in seat order that sets
it.`,
  imports: `import type { ReactNode } from "react";
import type { Unsubscribe } from "@kernel";`,
  declarations: `
export interface FolderLook {
  /** Any CSS colour, behind the icon and the name. Pair it with a \`color\` that reads on it. */
  readonly background?: string;
  /** Any CSS colour, for the icon and the name. */
  readonly color?: string;
  /** Drawn before the name, about one line high. It inherits \`color\` as \`currentColor\`. */
  readonly icon?: ReactNode;
}`,
  shape: s.object({
    id: s.string(),
    decorate: s
      .func()
      .as("(id: string) => FolderLook | undefined")
      .describe("Called on every render of every row, with the note's id: answer from memory, never await."),
    onChange: s
      .func()
      .as("(listener: () => void) => Unsubscribe")
      .describe("Fires when any answer `decorate` gives may have changed."),
  }),
};
