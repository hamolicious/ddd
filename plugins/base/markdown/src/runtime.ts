import { embedReplace, embedToggle, type EmbedLocation } from "./embed-toggle.js";
import type { ComponentType } from "react";

import type { DocumentRow, Kernel, RegistryEntry } from "@kernel";
import type { ContextMenu } from "plugin:context-menu";
import type { DocumentMode, DocumentModeProps } from "plugin:document-surface";
import type { Folders, NoteLook } from "plugin:folders";
import type { Router } from "plugin:router";

import { regionsOf } from "../../_shared/regions.js";
import { resolveMarkerOffset, type TaskLocation, type TaskScan } from "./tasks.js";

export const TASK_SPLICE_ORIGIN = { plugin: "markdown", write: "taskState" } as const;
export const EMBED_SPLICE_ORIGIN = { plugin: "markdown", write: "embed" } as const;

export const DOC_ROUTE = "/doc/:id";

export interface AttachmentMeta {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

export interface AttachmentBlob {
  readonly objectUrl: string;
  readonly mime: string;
}

export interface TaskWriteRequest {
  readonly documentId: string;
  readonly offset: number | undefined;
  readonly expected: TaskLocation;
  readonly ordinal: number;
  readonly next: string;
  readonly rescan: (body: string) => TaskScan;
}

export interface MarkdownRuntime {
  readonly kernel: Kernel;
  openDocument(id: string, fragment?: string | null): void;
  titleOf(id: string): Promise<string | undefined>;
  lookOf(id: string): NoteLook | undefined;
  onLookChange(listener: () => void): () => void;
  attachmentMeta(id: string): Promise<AttachmentMeta | null>;
  attachmentBlob(id: string): Promise<AttachmentBlob | null>;
  downloadAttachment(id: string): Promise<void>;
  openMenu(from: HTMLElement): void;
  focusAttachment(id: string | null, site?: EmbedSite): void;
  focusedAttachment(): string | null;
  focusedSite(): EmbedSite | undefined;
  promoteEmbed(attachmentId: string, site?: EmbedSite): Promise<string>;
  promote(attachmentId: string): Promise<string>;
  writeTaskMarker(request: TaskWriteRequest): Promise<boolean>;
  toggleEmbed(request: EmbedToggleRequest): Promise<void>;
  embedView?(row: DocumentRow): ComponentType<DocumentModeProps> | undefined;
}

export interface EmbedSite {
  readonly documentId: string;
  readonly offset: number | undefined;
  readonly location: EmbedLocation;
}

export type EmbedToggleRequest = EmbedSite;

export interface RuntimeDeps {
  readonly router?: Pick<Router, "navigate" | "href">;
  readonly folders?: Pick<Folders, "fileNew" | "look" | "onLookChange">;
  readonly menu?: Pick<ContextMenu, "openFor">;
  readonly modes?: () => readonly RegistryEntry<DocumentMode>[];
}

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);

export function isInlineImage(mime: string): boolean {
  return INLINE_IMAGE_TYPES.has(mime.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}

export function createRuntime(
  kernel: Kernel,
  deps: RuntimeDeps = {},
): MarkdownRuntime & { dispose(): void } {
  const { router, folders, menu, modes } = deps;
  const metaCache = new Map<string, Promise<AttachmentMeta | null>>();
  const blobCache = new Map<string, Promise<AttachmentBlob | null>>();
  const objectUrls: string[] = [];
  let focused: string | null = null;
  let focusedSite: EmbedSite | undefined;

  const spliceEmbed = async (
    site: EmbedSite,
    edit: (text: string, base: number) => ReturnType<typeof embedToggle>,
  ): Promise<void> => {
    const open = await kernel.documents.open(site.documentId);
    try {
      const text = open.text.toString();
      const change = edit(text, site.offset ?? regionsOf(text).body.start);
      if (!change) {
        kernel.ui.notify({
          id: `markdown.embed.${site.documentId}`,
          level: "warning",
          message: "The document changed while you were reading, so the file was left as it was.",
          detail: "Reopen it and try again.",
        });
        return;
      }
      kernel.documents.splice.apply(open, [change], EMBED_SPLICE_ORIGIN);
    } finally {
      open.release();
    }
  };

  const fetchMeta = async (id: string): Promise<AttachmentMeta | null> => {
    try {
      const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(id)}/meta`);
      const body = (await response.json()) as Partial<AttachmentMeta>;
      return {
        id,
        name: typeof body.name === "string" ? body.name : id,
        mime: typeof body.mime === "string" ? body.mime : "application/octet-stream",
        size: typeof body.size === "number" ? body.size : 0,
      };
    } catch (error) {
      kernel.log.debug("attachment metadata unavailable", { id, error });
      return null;
    }
  };

  const fetchBlob = async (id: string): Promise<AttachmentBlob | null> => {
    try {
      const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(id)}`);
      const blob = await response.blob();
      const mime = blob.type || (await fetchMeta(id))?.mime || "application/octet-stream";
      const objectUrl = URL.createObjectURL(blob);
      objectUrls.push(objectUrl);
      return { objectUrl, mime };
    } catch (error) {
      kernel.log.debug("attachment not available", { id, error });
      return null;
    }
  };

  const views = new WeakMap<ComponentType<DocumentModeProps>, ComponentType<DocumentModeProps>>();

  const runtime: MarkdownRuntime & { dispose(): void } = {
    embedView: (row) => {
      for (const entry of modes?.() ?? []) {
        const mode = entry.value;
        try {
          if (mode.when?.(row) === false || mode.prefer?.(row) !== true) continue;
        } catch (error) {
          kernel.log.warn(`document.mode "${mode.id}" threw deciding an embed`, error);
          continue;
        }
        let view = views.get(mode.component);
        if (!view) {
          view = kernel.ui.boundary(mode.component, { point: "document-surface.mode", pluginId: entry.pluginId });
          views.set(mode.component, view);
        }
        return view;
      }
      return undefined;
    },
    kernel,

    openDocument: (id, fragment) => {
      const base = router ? router.href(DOC_ROUTE, { id }) : `/doc/${encodeURIComponent(id)}`;
      const path = fragment ? `${base}#${fragment}` : base;
      if (router) router.navigate(path);
      else location.hash = path;
    },

    titleOf: async (id) => {
      const row = await kernel.documents.get(id);
      return row?.title;
    },

    lookOf: (id) => {
      if (!folders) return undefined;
      try {
        return folders.look(id);
      } catch {
        return undefined;
      }
    },

    onLookChange: (listener) => {
      if (!folders) return () => undefined;
      return folders.onLookChange(listener);
    },

    attachmentMeta: (id) => {
      const existing = metaCache.get(id);
      if (existing) return existing;
      const pending = fetchMeta(id);
      metaCache.set(id, pending);
      return pending;
    },

    attachmentBlob: (id) => {
      const existing = blobCache.get(id);
      if (existing) return existing;
      const pending = fetchBlob(id);
      blobCache.set(id, pending);
      return pending;
    },

    downloadAttachment: async (id) => {
      const [blob, meta] = await Promise.all([runtime.attachmentBlob(id), runtime.attachmentMeta(id)]);
      if (!blob) {
        kernel.ui.notify({
          id: `markdown.attachment.${id}`,
          level: "warning",
          message: "That file is not on this device. Reconnect to download it.",
          detail: `attachment://${id}`,
        });
        return;
      }
      const anchor = document.createElement("a");
      anchor.href = blob.objectUrl;
      anchor.download = meta?.name ?? id;
      anchor.rel = "noopener";
      anchor.click();
    },

    openMenu: (from) => {
      menu?.openFor(from);
    },

    focusAttachment: (id, site) => {
      focused = id;
      focusedSite = id === null ? undefined : site;
    },
    focusedAttachment: () => focused,
    focusedSite: () => focusedSite,

    promoteEmbed: async (attachmentId, site) => {
      const created = await runtime.promote(attachmentId);
      if (!site) return created;
      const meta = await runtime.attachmentMeta(attachmentId);
      const title = (meta?.name ?? attachmentId).replace(/[[\]\r\n]/g, "");
      await spliceEmbed(site, (text, base) =>
        embedReplace(text, base, site.location, `[${title}](doc://${created})`),
      );
      return created;
    },

    promote: async (attachmentId) => {
      const meta = await runtime.attachmentMeta(attachmentId);
      const title = meta?.name ?? attachmentId;
      const lines = ["---", `title: ${yamlScalar(title)}`, "---", "", `![${title.replace(/[[\]]/g, "")}](attachment://${attachmentId})`, ""];
      const id = await kernel.documents.create({ text: lines.join("\n") });
      if (folders) {
        await folders
          .fileNew(id, "file")
          .catch((cause: unknown) => kernel.log.warn("could not file the promoted document", cause));
      }
      return id;
    },

    writeTaskMarker: async ({ documentId, offset, expected, ordinal, next, rescan }) => {
      const open = await kernel.documents.open(documentId);
      try {
        const text = open.text.toString();
        const regions = regionsOf(text);
        const base = offset ?? regions.body.start;
        const at = resolveMarkerOffset(text, base, expected, ordinal, () =>
          rescan(text.slice(base, offset === undefined ? regions.body.end : text.length)),
        );
        if (at === null) {
          kernel.ui.notify({
            id: `markdown.task.${documentId}`,
            level: "warning",
            message:
              "The document changed while you were reading, so nothing was ticked.",
            detail: "Reopen it and try again.",
          });
          return false;
        }
        kernel.documents.splice.apply(
          open,
          [{ range: { start: at, end: at + 1 }, text: next }],
          TASK_SPLICE_ORIGIN,
        );
        return true;
      } finally {
        open.release();
      }
    },

    toggleEmbed: (site) => spliceEmbed(site, (text, base) => embedToggle(text, base, site.location)),

    dispose: () => {
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.length = 0;
      metaCache.clear();
      blobCache.clear();
    },
  };

  return runtime;
}

function yamlScalar(value: string): string {
  const control = /[\u0000-\u001f]/.test(value);
  const needsQuotes =
    control || /^["'\s>|@`%&*!{}[\],#?:-]|[:#]\s|\s$|^$|^(?:true|false|null|~|-?\d)/i.test(value);
  if (!needsQuotes) return value;
  let out = '"';
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else if (character === "\n") out += "\\n";
    else if (character === "\r") out += "\\r";
    else if (character === "\t") out += "\\t";
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += character;
  }
  return `${out}"`;
}
