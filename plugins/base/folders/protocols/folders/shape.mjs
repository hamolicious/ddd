import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/folders",
  version: "1.2.0",
  kind: "service",
  name: "Folders",
  description: `
Where a note sits in the folder tree. A folder is a note: its children are listed in its own
\`%%% folders\` section, which only \`folders\` writes, so other plugins file notes through
this service. A note has at most one parent; \`""\` is the root.

It also says how a note is dressed — the colour and icon other plugins give it in the tree
(\`lm/folders.decoration\`) — so a link to the note elsewhere can wear the same.`,
  imports: `import type { ReactNode } from "react";

import type { Unsubscribe } from "@kernel";`,
  declarations: `
/** How a note is dressed: the first of each field in the decorations' seat order. */
export interface NoteLook {
  readonly background?: string;
  readonly color?: string;
  /** About one line high; inherits \`color\` as \`currentColor\`. */
  readonly icon?: ReactNode;
}`,
  shape: s.object({
    parentOf: s
      .func()
      .as("(id: string) => string | undefined")
      .describe("The note's parent id, `\"\"` at the root, `undefined` for a note the tree does not know."),
    file: s
      .func()
      .as("(id: string, parent: string, index?: number) => Promise<void>")
      .describe(
        "Put the note under `parent` (`\"\"` for the root), before the child at `index` or last. Rejects a parent inside the note itself.",
      ),
    fileNew: s
      .func()
      .as('(id: string, kind: "note" | "file") => Promise<void>')
      .describe(
        "File a document just created where the person asked new ones of that kind to go (\"New notes go to\", \"Files go to\"). Does nothing when that is the root.",
      ),
    look: s
      .func()
      .as("(id: string) => NoteLook | undefined")
      .describe("The note's colour and icon, as the tree draws them. Since 1.2.0."),
    onLookChange: s
      .func()
      .as("(listener: () => void) => Unsubscribe")
      .describe("Fires when any answer `look` gives may have changed. Since 1.2.0."),
    ensurePath: s
      .func()
      .as("(titles: readonly string[]) => Promise<string>")
      .describe(
        "The id of the note at that chain of titles from the root, creating the missing ones (without opening them). `[]` is the root, `\"\"`.",
      ),
  }),
};
