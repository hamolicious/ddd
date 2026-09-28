/**
 * lm/commands.command@1.0.0: slot, owned by `commands`.
 *
 * A command: one id, one title, one function. The palette lists them; keybindings run
 * them. Two providers claiming one id: the lower seat wins and the other is reported.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ReactNode } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/commands.command";
export type ProtocolVersion = "1.0.0";

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly run: (argument?: unknown) => void | Promise<void>;
  /** Grouping in the palette. */
  readonly category?: string;
  readonly icon?: ReactNode;
  /** Return `false` to hide the command in the current context. */
  readonly when?: () => boolean;
}
