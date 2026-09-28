/**
 * lm/settings.section@1.0.0: slot, owned by `settings`.
 *
 * One section of the settings screen. Sections appear in seat order.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/settings.section";
export type ProtocolVersion = "1.0.0";

export interface SettingsSection {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<Record<string, never>>;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
  readonly description?: string;
}
