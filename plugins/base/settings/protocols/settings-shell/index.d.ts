/**
 * lm/settings-shell@1.0.0: service, owned by `settings`.
 *
 * The settings screen: open it at a section, and list the sections wired into it.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { SettingsSection } from "@protocols/lm/settings.section";

/** The protocol this package describes. */
export type ProtocolId = "lm/settings-shell";
export type ProtocolVersion = "1.0.0";

export interface SettingsShell {
  readonly open: (sectionId?: string) => void;
  readonly sections: () => readonly SettingsSection[];
}
