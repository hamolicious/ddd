/**
 * What `toolbar` exports to other plugins (`plugin:toolbar`): the item type and the
 * module-scope registry that collects items.
 */

import type { ComponentType, ReactNode } from "react";

import { createRegistry, s } from "@kernel";

/** Which bar: the one above the app or the one below it. */
export type Bar = "top" | "bottom";

/** Which end of a bar. */
export type Side = "start" | "end";

/** Where an item asks to go. The user's layout in Settings → Toolbar wins. */
export interface Placement {
  /** Default `top` on desktop, `bottom` on a phone. */
  readonly bar?: Bar;
  /** Default `start`. The phone's bottom toolbar is one row and ignores it. */
  readonly side?: Side;
}

/** One item in the toolbar. */
export interface ToolbarItem extends Placement {
  readonly id: string;
  readonly label: string;
  /** Any renderable node: an inline SVG, a character, a component's output. Carries the item on a phone's bottom toolbar. */
  readonly icon?: ReactNode;
  /** Position within its seat; lower first. Default 100. */
  readonly order?: number;
  /** Where it goes on a phone, when that differs. `side` falls back to the item's own. */
  readonly mobile?: Placement;
  readonly onSelect?: () => void;
  /** Takes over rendering entirely (the notice bell, the sync pill). */
  readonly component?: ComponentType<Record<string, never>>;
}

/** The old name, from when this plugin was `header`. */
export type NavbarItem = ToolbarItem;

const placement = s.object({
  bar: s.optional(s.literal("top", "bottom")),
  side: s.optional(s.literal("start", "end")),
});

export const itemRegistry = createRegistry<ToolbarItem>({
  key: (item) => item.id,
  order: (item) => item.order ?? 100,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    icon: s.optional(s.any()),
    order: s.optional(s.number()),
    bar: s.optional(s.literal("top", "bottom")),
    side: s.optional(s.literal("start", "end")),
    mobile: s.optional(placement),
    onSelect: s.optional(s.func()),
    component: s.optional(s.component()),
  }),
});
