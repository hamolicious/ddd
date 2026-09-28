/**
 * lm/attachments.viewer@1.0.0: slot, owned by `attachments`.
 *
 * A way of showing files of some types, by extension. Several viewers may claim one
 * extension: the first seat shows it unless the user picked another in Settings,
 * Attachments.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

import type { ComponentType } from "react";

/** The protocol this package describes. */
export type ProtocolId = "lm/attachments.viewer";
export type ProtocolVersion = "1.0.0";

export interface AttachmentViewerProps {
  readonly file: {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
  };
  /** The bytes, already fetched over the session. */
  readonly blob: Blob;
  /** An object URL for `blob`, owned by `attachments`: do not revoke it. */
  readonly url: string;
  readonly placement: "inline" | "page";
}

export interface AttachmentViewer {
  readonly id: string;
  /** Shown in Settings when viewers compete for a type. */
  readonly label: string;
  /** Lower case, no dot: `["png", "jpg"]`. */
  readonly extensions: readonly (string)[];
  readonly component: ComponentType<AttachmentViewerProps>;
  /** Default-seat hint only; the wiring's seat order wins. */
  readonly order?: number;
}
