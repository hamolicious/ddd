import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/settings-shell",
  version: "1.0.0",
  kind: "service",
  name: "SettingsShell",
  description: "The settings screen: open it at a section, and list the sections wired into it.",
  imports: `import type { SettingsSection } from "@protocols/lm/settings.section";`,
  shape: s.object({
    open: s.func().as("(sectionId?: string) => void"),
    sections: s.func().as("() => readonly SettingsSection[]"),
  }),
};
