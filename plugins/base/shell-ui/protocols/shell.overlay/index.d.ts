/**
 * lm/shell.overlay@1.0.0: slot, owned by `shell-ui`.
 *
 * A component that is always mounted, outside the header, sidebar and main region: a
 * command palette, a toast stack, a sheet. The shell holds the only `kernel.ui.mount`, so
 * this is how a plugin gets a persistent React presence that is not part of the layout. It
 * should render nothing until it has something to show, and anything modal should portal
 * or position itself.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/shell.overlay";
export type ProtocolVersion = "1.0.0";

export interface ShellOverlay {
  readonly id: string;
  readonly component: ComponentType<Record<string, never>>;
}
