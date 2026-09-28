import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/keybindings.default",
  version: "1.0.0",
  kind: "slot",
  name: "KeybindingDefault",
  key: ["keys", "command"],
  description: `
A suggested default binding. The user's own configuration wins; between providers, the lower
seat wins and conflicts are listed rather than silently resolved. \`keys\` is a chord in the
canonical spelling: \`Mod+K\` (\`Mod\` is Cmd on Apple, Ctrl elsewhere), \`Shift+Alt+F\`, or a
sequence like \`g d\`.`,
  shape: s.object({
    command: s.string(),
    keys: s.string(),
    when: s.optional(s.string()),
  }),
};
