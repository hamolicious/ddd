/**
 * lm/main.view@1.0.0: slot, owned by `shell-ui`.
 *
 * A full-pane view, addressed by id. `lm/router.route` maps a URL to one of these, so a
 * view and its URL are provided independently: a view can be opened by the router, by a
 * command, or in a split.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/main.view";
export type ProtocolVersion = "1.0.0";

export interface MainView {
  readonly id: string;
  readonly component: ComponentType<{ readonly params?: Readonly<Record<string, string>> }>;
  /** Shown in window and tab titles. */
  readonly title?: string;
}
