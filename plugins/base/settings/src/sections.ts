import type { ComponentType } from "react";

import { createRegistry, s } from "@kernel";

export interface SettingsSection {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<Record<string, never>>;
  readonly order?: number;
  readonly description?: string;
}

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
