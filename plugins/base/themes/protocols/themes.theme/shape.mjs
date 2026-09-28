import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/themes.theme",
  version: "1.0.0",
  kind: "slot",
  name: "Theme",
  key: "id",
  description: `
A theme: token overrides on top of the kernel defaults. \`themes\` overrides the palette, it
does not own it, so a theme need only name the tokens it changes and everything else stays
legible.`,
  shape: s.object({
    id: s.string(),
    name: s.string(),
    scheme: s.literal("light", "dark"),
    tokens: s.record(s.string()).describe("Partial `ThemeTokens`: token name → CSS value."),
  }),
};
