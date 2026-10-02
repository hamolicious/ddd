import type { ComponentType, ReactNode } from "react";

import { createRegistry, s } from "@kernel";

export type Bar = "top" | "bottom";

export type Side = "start" | "end";

export interface Placement {
  readonly bar?: Bar;
  readonly side?: Side;
}

export interface ToolbarItem extends Placement {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly order?: number;
  readonly mobile?: Placement;
  readonly onSelect?: () => void;
  readonly component?: ComponentType<Record<string, never>>;
}

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
