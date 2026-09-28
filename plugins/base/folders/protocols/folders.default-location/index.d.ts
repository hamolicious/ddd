/**
 * lm/folders.default-location@1.0.0: event, owned by `folders`.
 *
 * Where new notes go when the caller names no folder. Sent at activation and on every
 * change, here or on another device. Sticky: a listener that starts or restarts later
 * still hears the current value at once. An explicit location, like "New document here" in
 * the tree, always beats it.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/folders.default-location";
export type ProtocolVersion = "1.0.0";

export interface DefaultLocation {
  /** A folder path, `""` for the root. */
  readonly path: string;
}
