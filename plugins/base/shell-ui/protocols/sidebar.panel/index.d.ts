/**
 * lm/sidebar.panel@1.0.0: slot, owned by `shell-ui`.
 *
 * A panel in the sidebar (folders, the document list, an outline). Collapsible. Panels
 * appear top to bottom in seat order.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType, ReactNode } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/sidebar.panel";
export type ProtocolVersion = "1.0.0";

export interface SidebarPanel {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<Record<string, never>>;
  readonly icon?: ReactNode;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
  /** `true` ⇒ the panel starts open on first run. */
  readonly defaultOpen?: boolean;
}
