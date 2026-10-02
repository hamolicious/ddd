import type { Kernel, SettingsValue } from "@kernel";
import { addPasteHandler, type EditorInsertion } from "plugin:editor";
import { addAttachmentRenderer } from "plugin:markdown";
import { addSection } from "plugin:settings";
import { addSlashCommand } from "plugin:slash-commands";

import { viewerRegistry, type AttachmentViewer, type UploadOptions, type UploadResponse } from "./api.js";

import { extensionOf, pasteAs, schema, settingKey } from "./kinds.js";
import { newToken, waitingPlaceholder, type WaitingUpload } from "./queue.js";
import { createUploads, type Uploads } from "./uploads.js";
import { createAttachmentsApi } from "./uploader.js";
import { FileTypeSettings } from "./FileTypeSettings.js";
import { createAttachmentView, createViewers } from "./view.js";

export type {
  Attachments,
  AttachmentViewer,
  AttachmentViewerProps,
  UploadOptions,
  UploadResponse,
} from "./api.js";

type FoldersModule = typeof import("plugin:folders");

export const addViewer: (items: AttachmentViewer | readonly AttachmentViewer[]) => () => void = viewerRegistry.add;

let uploader: ((blob: Blob, name: string, options?: UploadOptions) => Promise<UploadResponse>) | undefined;

export function upload(blob: Blob, name: string, options?: UploadOptions): Promise<UploadResponse> {
  if (!uploader) return Promise.reject(new Error("attachments is not active yet"));
  return uploader(blob, name, options);
}

let liveUploads: Uploads | undefined;

export default function activate(kernel: Kernel): void {
  try {
    kernel.settings.defineSchema(schema());
  } catch (error) {
    kernel.log.warn("paste settings could not be declared; every file will be linked", error);
  }

  const read = (key: string): SettingsValue | undefined => {
    try {
      return kernel.settings.get(key);
    } catch {
      return undefined;
    }
  };

  const viewers = createViewers(kernel, viewerRegistry, read);

  addAttachmentRenderer({
    id: "attachments",
    component: createAttachmentView(kernel, viewers),
  });

  const remember = (extension: string): void => {
    const key = settingKey(extension);
    if (read(key) !== undefined) return;
    kernel.settings.set(key, "link").catch((error: unknown) => {
      kernel.log.debug(`could not remember .${extension} in the paste settings`, error);
    });
  };

  const uploads = createUploads(kernel);
  liveUploads = uploads;
  void uploads.restore();
  kernel.sync.subscribe((state) => {
    if (state.status === "synced") uploads.reconnected();
  });

  const placeAll = (files: readonly File[], documentId: string, insert: (text: string) => EditorInsertion): void => {
    files.forEach((file, index) => {
      if (index > 0) insert("\n");
      const extension = extensionOf(file.name, file.type);
      const name = file.name || "pasted file";
      const token = newToken();
      const entry: WaitingUpload = {
        token,
        documentId,
        placeholder: waitingPlaceholder(name, token),
        name,
        type: file.type,
        as: extension ? pasteAs(read(settingKey(extension))) : "link",
        blob: file,
        at: Date.now(),
      };
      if (extension) remember(extension);
      void uploads.add(entry, insert(entry.placeholder));
    });
  };

  addPasteHandler({
    id: "attachments.upload",
    paste: (event) => {
      if (event.files.length === 0) return false;
      placeAll(event.files, event.documentId, (text) => event.insert(text));
      return true;
    },
  });

  addSlashCommand({
    id: "attachments.attach",
    title: "Attach file",
    description: "Upload files from this device",
    keywords: ["file", "upload", "image", "photo"],
    icon: "📎",
    order: 10,
    run: ({ documentId, mark, focus }) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.hidden = true;
      const done = (): void => {
        input.remove();
        focus();
      };
      input.addEventListener("change", () => {
        placeAll(Array.from(input.files ?? []), documentId, (text) => mark.insert(text));
        done();
      });
      input.addEventListener("cancel", done);
      document.body.append(input);
      input.click();
    },
  });

  addSection({
    id: "attachments",
    title: "Attachments",
    order: 40,
    description: "How each file type is pasted, and which viewer shows it.",
    component: () => <FileTypeSettings kernel={kernel} viewers={viewers} />,
  });

  let folders: FoldersModule | undefined;
  void kernel.plugins
    .optional<FoldersModule>("folders")
    .then((module) => {
      folders = module;
    })
    .catch((cause: unknown) => kernel.log.warn("folders unavailable; new file documents stay unfiled", cause));

  const sender = createAttachmentsApi(kernel.session.fetch.bind(kernel.session));
  uploader = async (blob, name, options) => {
    const response = await sender.upload(blob, name, options);
    if (response.document_id !== undefined && folders) {
      await folders
        .fileNew(response.document_id, "file")
        .catch((cause: unknown) => kernel.log.warn("could not file the new file document", cause));
    }
    return response;
  };
}

export function deactivate(): void {
  liveUploads?.dispose();
  liveUploads = undefined;
  uploader = undefined;
}
