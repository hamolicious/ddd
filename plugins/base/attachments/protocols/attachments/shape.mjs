import { s } from "@kernel";

/** @type {import("@kernel").ProtocolSource} */
export default {
  id: "lm/attachments",
  version: "2.0.0",
  kind: "service",
  name: "Attachments",
  description: "Uploading files through the server's resumable chunk protocol.",
  declarations: `
export interface UploadOptions {
  /** Resume an upload this client started before. */
  readonly uploadId?: string;
  readonly signal?: AbortSignal;
  /**
   * Also create a wrapper document for the file. It is filed where the folder tree's
   * "Files go to" says, when \`folders\` is wired.
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
  /** The \`attachment://\` reference to embed. */
  readonly reference: string;
  readonly document_id?: string;
}`,
  shape: s.object({
    upload: s
      .func()
      .as("(blob: Blob, name: string, options?: UploadOptions) => Promise<UploadResponse>")
      .describe("Upload one file."),
  }),
};
