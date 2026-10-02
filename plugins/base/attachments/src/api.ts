import type { ComponentType } from "react";

import { createRegistry, s } from "@kernel";

export interface UploadOptions {
  readonly uploadId?: string;
  readonly signal?: AbortSignal;
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
  readonly reference: string;
  readonly document_id?: string;
}

export interface Attachments {
  readonly upload: (blob: Blob, name: string, options?: UploadOptions) => Promise<UploadResponse>;
}

export interface AttachmentViewerProps {
  readonly file: {
    readonly id: string;
    readonly name: string;
    readonly mime: string;
    readonly size: number;
  };
  readonly blob: Blob;
  readonly url: string;
  readonly placement: "inline" | "page";
}

export interface AttachmentViewer {
  readonly id: string;
  readonly label: string;
  readonly extensions: readonly string[];
  readonly component: ComponentType<AttachmentViewerProps>;
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
