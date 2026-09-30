/**
 * The settings screen's sections: the type other plugins contribute and the module-scope
 * registry that collects them (`addSection` in `plugin:settings`).
 */

import type { ComponentType } from "react";

import { createRegistry, s } from "@kernel";

/** One section of the settings screen. */
export interface SettingsSection {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<Record<string, never>>;
  /** Position in the list; lower first. Default 100. */
  readonly order?: number;
  readonly description?: string;
}

/** The settings screen as a service: open it at a section, and list its sections. */
export interface SettingsShell {
  readonly open: (sectionId?: string) => void;
  readonly sections: () => readonly SettingsSection[];
}

export const sectionRegistry = createRegistry<SettingsSection>({
  key: (section) => section.id,
  order: (section) => section.order ?? 100,
  shape: s.object({
    id: s.string(),
    title: s.string(),
    component: s.component(),
    order: s.optional(s.number()),
    description: s.optional(s.string()),
  }),
});
