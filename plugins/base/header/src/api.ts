/**
 * What `header` exports to other plugins (`plugin:header`): the item type and the
 * module-scope registry that collects items.
 */

import type { ComponentType, ReactNode } from "react";

import { createRegistry, s } from "@kernel";

/** One item in the top bar. */
export interface NavbarItem {
  readonly id: string;
  readonly label: string;
  /** Any renderable node: an inline SVG, a character, a component's output. */
  readonly icon?: ReactNode;
  /** Position within its side; lower first. Default 100. The user's arrangement in Settings → Top bar wins. */
  readonly order?: number;
  /** `start` sits after the sidebar toggle and grows, scrolling sideways when full; `end` is pushed right and never shrinks. Default `start`. */
  readonly side?: "start" | "end";
  readonly onSelect?: () => void;
  /** Takes over rendering entirely (the notice bell, the sync pill). */
  readonly component?: ComponentType<Record<string, never>>;
}

export const itemRegistry = createRegistry<NavbarItem>({
  key: (item) => item.id,
  order: (item) => item.order ?? 100,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    icon: s.optional(s.any()),
    order: s.optional(s.number()),
    side: s.optional(s.literal("start", "end")),
    onSelect: s.optional(s.func()),
    component: s.optional(s.component()),
  }),
});
