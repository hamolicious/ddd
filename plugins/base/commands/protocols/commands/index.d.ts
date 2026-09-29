/**
 * lm/commands@1.0.0: service, owned by `commands`.
 *
 * The command registry, for plugins that run commands rather than offer them: a list to
 * build a menu from, and a way to run one by id. `when()` is honoured by both.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { Command } from "@protocols/lm/commands.command";

/** The protocol this package describes. */
export type ProtocolId = "lm/commands";
export type ProtocolVersion = "1.0.0";

export interface Commands {
  /** Every command enabled right now, in seat order. */
  readonly list: () => readonly Command[];
  /** Run a command by id. Rejects for an unknown id; does nothing when its `when()` says no. */
  readonly run: (id: string, argument?: unknown) => Promise<void>;
  readonly openPalette: (initialQuery?: string) => void;
}
