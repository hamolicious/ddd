/**
 * lm/attachments@2.0.0: service, owned by `attachments`.
 *
 * Uploading files through the server's resumable chunk protocol.
 *
 * GENERATED from shape.mjs by web/scripts/gen-protocols.ts. Do not edit.
 */

/** The protocol this package describes. */
export type ProtocolId = "lm/attachments";
export type ProtocolVersion = "2.0.0";

export interface UploadOptions {
  /** Resume an upload this client started before. */
  readonly uploadId?: string;
  readonly signal?: AbortSignal;
  /**
   * Also create a wrapper document for the file. It is filed where the folder tree's
   * "Files go to" says, when `folders` is wired.
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

export interface Attachments {
  /** Upload one file. */
  readonly upload: (blob: Blob, name: string, options?: UploadOptions) => Promise<UploadResponse>;
}
