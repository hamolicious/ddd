/**
 * lm/markdown.taskState@1.0.0: slot, owned by `markdown`.
 *
 * A task marker. `[ ]` and `[x]` are markdown's own; a plugin may add `[/]`, `[-]`, `[?]`.
 * Marker meaning comes from the client, so a client without the providing plugin renders
 * the marker as literal text. States appear in the state menu in seat order.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ReactNode } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/markdown.taskState";
export type ProtocolVersion = "1.0.0";

export interface MarkdownTaskState {
  /** The single character inside the brackets; `" "` for unchecked. */
  readonly marker: string;
  readonly label: string;
  readonly icon: ReactNode;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
  /** `true` ⇒ counts as completed. */
  readonly done?: boolean;
}
