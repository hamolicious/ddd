/**
 * lm/shell.header@1.0.0: slot, owned by `shell-ui`.
 *
 * The spot above the sidebar and main region. A host shows one: `shell-ui` hosts it with
 * `"seats": 1`, so a new connection takes the seat and benches the previous header. The
 * component owns its whole row, `<header>` included.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/shell.header";
export type ProtocolVersion = "1.0.0";

export interface ShellHeader {
  readonly id: string;
  readonly component: ComponentType<Record<string, never>>;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
}
