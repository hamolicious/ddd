/**
 * lm/folders.moved@1.0.0: event, owned by `folders`.
 *
 * A folder was renamed, moved or deleted from this device, so anything kept per folder
 * path can follow it. Sent once the change has gone through completely; a move that partly
 * failed is announced when a retry finishes it.
 *
 * - `to` set: the folder `from` and everything inside it now live at `to`. - `to` absent:
 * `from` is gone. With `contentsTo`, what was inside it moved up into that folder (`""`
 * for the root); without it, the contents went to the Trash.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/folders.moved";
export type ProtocolVersion = "1.0.0";

export interface FolderMoved {
  readonly from: string;
  readonly to?: string;
  readonly contentsTo?: string;
}
