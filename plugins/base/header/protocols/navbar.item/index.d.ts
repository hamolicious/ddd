/**
 * lm/navbar.item@1.0.0: slot, owned by `header`.
 *
 * One item in the top bar, placed in one of the header's two sides. `component` renders
 * it; `onSelect` is the shorthand for the common case, a button that runs a command.
 *
 * A provider's items appear in its seat's order; the header's own "Top bar" setting lets
 * each person rearrange them on top of that.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType, ReactNode } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/navbar.item";
export type ProtocolVersion = "1.0.0";

export interface NavbarItem {
  readonly id: string;
  readonly label: string;
  /** Any renderable node: an inline SVG, a character, a component's output. */
  readonly icon?: ReactNode;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
  /** `start` sits after the sidebar toggle and grows; `end` is pushed right and never shrinks. Default `start`. */
  readonly side?: "start" | "end";
  readonly onSelect?: () => void;
  /** Takes over rendering entirely (the notice bell, the sync pill). */
  readonly component?: ComponentType<Record<string, never>>;
}
