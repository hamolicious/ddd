import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/folders.moved",
  version: "1.0.0",
  kind: "event",
  name: "FolderMoved",
  description: `
A folder was renamed, moved or deleted from this device, so anything kept per folder path can
follow it. Sent once the change has gone through completely; a move that partly failed is
announced when a retry finishes it.

- \`to\` set: the folder \`from\` and everything inside it now live at \`to\`.
- \`to\` absent: \`from\` is gone. With \`contentsTo\`, what was inside it moved up into that
  folder (\`""\` for the root); without it, the contents went to the Trash.`,
  shape: s.object({
    from: s.string(),
    to: s.optional(s.string()),
    contentsTo: s.optional(s.string()),
  }),
};
