/**
 * What other plugins write against: the upload types and the viewer registry
 * `addViewer` fills. A viewer's shape is checked when it is added, so a malformed one
 * fails in the adding plugin's `activate`.
 */

import type { ComponentType } from "react";

import { createRegistry, s } from "@kernel";

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export interface UploadOptions {
  /** Resume an upload this client started before. */
  readonly uploadId?: string;
  readonly signal?: AbortSignal;
  /**
   * Also create a wrapper document for the file. It is filed where the folder tree's
   * "Files go to" says, when `folders` is enabled.
   */
  readonly wrapper?: boolean;
  readonly onSession?: (uploadId: string) => void | Promise<void>;
  readonly onProgress?: (sent: number) => void;
}

export interface UploadResponse {
  readonly attachment: {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
    readonly sha256: string;
    readonly revision: number;
  };
  /** The `attachment://` reference to embed. */
  readonly reference: string;
  readonly document_id?: string;
}

/** The upload functions as one type: the named exports of `plugin:attachments`. */
export interface Attachments {
  /** Upload one file through the server's resumable chunk protocol. */
  readonly upload: (blob: Blob, name: string, options?: UploadOptions) => Promise<UploadResponse>;
}

// ---------------------------------------------------------------------------
// Viewers
// ---------------------------------------------------------------------------

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

/**
 * A way of showing files of some types, by extension. Several viewers may claim one
 * extension: the first in `order` shows it unless the user picked another in Settings,
 * Attachments.
 */
export interface AttachmentViewer {
  readonly id: string;
  /** Shown in Settings when viewers compete for a type. */
  readonly label: string;
  /** Lower case, no dot: `["png", "jpg"]`. */
  readonly extensions: readonly string[];
  readonly component: ComponentType<AttachmentViewerProps>;
  /** Lower first; the first is the default for its extensions. Default 100. */
  readonly order?: number;
}

export const viewerRegistry = createRegistry<AttachmentViewer>({
  key: (viewer) => viewer.id,
  order: (viewer) => viewer.order ?? 100,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    extensions: s.array(s.string()),
    component: s.component(),
    order: s.optional(s.number()),
  }),
});
