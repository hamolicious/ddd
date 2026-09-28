/**
 * lm/altbar.panel@1.0.0: slot, owned by `shell-ui`.
 *
 * A panel in the altbar: the column opposite the sidebar, about whatever the main view is
 * showing (a document's history, the neighbourhood graph). The shell draws the ones whose
 * `when` accepts the current view; with none, the altbar and its toggle are absent.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType, ReactNode } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/altbar.panel";
export type ProtocolVersion = "1.0.0";

/** Which `main.view` is showing, and the route's params: what an altbar panel is about. */
export interface ShownView {
  readonly id: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface AltbarPanel {
  readonly id: string;
  readonly title: string;
  readonly component: ComponentType<{ readonly view: ShownView }>;
  readonly icon?: ReactNode;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
  /** `true` ⇒ the panel starts expanded on first run. Default `true`. */
  readonly defaultOpen?: boolean;
  /** Whether this panel has anything to say about `view`. Default: every view. */
  readonly when?: (view: ShownView) => boolean;
}
