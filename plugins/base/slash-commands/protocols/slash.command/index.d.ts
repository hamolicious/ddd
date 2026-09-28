/**
 * lm/slash.command@1.0.0: slot, owned by `slash-commands`.
 *
 * One entry in the `/` menu. Typing `/att` lists the commands whose title or keywords
 * start with it. With nothing typed, and among equally good matches, commands appear in
 * seat order.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ReactNode } from "react";
import type { DocumentId } from "@kernel";
import type { TextMark } from "@protocols/lm/text.surface";

/** The protocol this package describes. */
export type ProtocolId = "lm/slash.command";
export type ProtocolVersion = "1.0.0";

export interface SlashCommandContext {
  readonly documentId: DocumentId;
  /** Where the `/command` was: insert here, now or after something slow. */
  readonly mark: TextMark;
  /** Give the editor its focus back. */
  focus(): void;
}

export interface SlashCommand {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  /** Other words it is found by. */
  readonly keywords?: readonly (string)[];
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
  /** `false` ⇒ not offered in this document. */
  readonly when?: (context: { readonly documentId: DocumentId }) => boolean;
  /** Called with the typed `/command` removed, inside the key press or tap that chose it, so it may open a file picker or anything else that needs a user gesture. */
  readonly run: (context: SlashCommandContext) => void;
}
