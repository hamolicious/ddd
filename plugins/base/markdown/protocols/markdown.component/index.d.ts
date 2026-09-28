/**
 * lm/markdown.component@1.0.0: slot, owned by `markdown`.
 *
 * Override the React component for one mdast node type (`link`, `heading`, `table`).
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/markdown.component";
export type ProtocolVersion = "1.0.0";

export interface MarkdownComponent {
  readonly node: string;
  readonly component: ComponentType<Record<string, unknown>>;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
}
