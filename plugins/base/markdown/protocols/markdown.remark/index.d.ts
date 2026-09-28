/**
 * lm/markdown.remark@1.0.0: slot, owned by `markdown`.
 *
 * A raw remark/unified plugin: the escalated path. It can change the meaning of the whole
 * document, so it is the last resort, not the first. Plugins run in seat order.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/markdown.remark";
export type ProtocolVersion = "1.0.0";

export interface MarkdownRemark {
  readonly id: string;
  /** A unified `Pluggable`, typed loosely so the protocol does not pin unified's types. */
  readonly plugin: unknown;
  readonly options?: unknown;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
}
