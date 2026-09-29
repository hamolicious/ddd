/**
 * lm/document-browser.created@1.0.0: event, owned by `doc-list`.
 *
 * A document was just created through `lm/document-browser` on this device. Sent once,
 * after the create went through and before it opens.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/document-browser.created";
export type ProtocolVersion = "1.0.0";

export interface DocumentCreated {
  readonly id: string;
  /** The caller's `parent` hint, when it gave one. */
  readonly parent?: string;
}
