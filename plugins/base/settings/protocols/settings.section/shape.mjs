import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/settings.section",
  version: "1.0.0",
  kind: "slot",
  name: "SettingsSection",
  key: "id",
  description: "One section of the settings screen. Sections appear in seat order.",
  shape: s.object({
    id: s.string(),
    title: s.string(),
    component: s.component().as("ComponentType<Record<string, never>>"),
    order: s.optional(s.number()).describe("Default-seat hint only; the wiring's seat order wins."),
    description: s.optional(s.string()),
  }),
};
