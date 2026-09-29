/**
 * lm/commands.command@2.0.0: slot, owned by `commands`.
 *
 * A command: one id, one title, one function. The palette lists them; keybindings run
 * them. Two providers claiming one id: the lower seat wins and the other is reported.
 *
 * A command with `takes: "documents"` acts on documents it is handed: its argument is the
 * ids, as `readonly string[]`. The document list's Actions button offers it for the
 * documents listed; the palette and keybindings, which have no documents to hand it, leave
 * it out.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/commands.command";
export type ProtocolVersion = "2.0.0";

export interface Command {
  readonly id: string;
  readonly title: string;
  readonly run: (argument?: unknown) => void | Promise<void>;
  /** Grouping in the palette. */
  readonly category?: string;
  /** An icon's name in `lm/icons` (Tabler), drawn beside the title. */
  readonly icon?: string;
  /** What the command acts on. `"documents"`: `run` gets `readonly string[]` of document ids. */
  readonly takes?: "documents";
  /** Return `false` to hide the command in the current context. */
  readonly when?: () => boolean;
}
