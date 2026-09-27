/**
 * Showing a file: the `markdown.attachment` renderer this plugin contributes.
 *
 * It finds the file's extension from its metadata, asks the `attachments.viewer`
 * registry who shows that type (the user's pick in Settings → Attachments, else the
 * lowest `order`), fetches the bytes once, and hands them over. With no viewer for the
 * type, or no bytes (offline and never fetched), it draws what `markdown` would have:
 * the `fallback`.
 *
 * Bytes are fetched over `kernel.session.fetch` and shown from an object URL, never from
 * the API URL: the Android shell authenticates with a bearer token a `src` cannot carry
 * (SPEC §5.2). One URL per attachment for the life of the page, like `markdown`'s cache,
 * so a re-render never flickers.
 */

import { OFFLINE_COPY_HEADER } from "../../_shared/offline-copy.js";
import type { ExtensionPoint, Kernel, SettingsValue } from "@kernel";
import { useEffect, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

import {
  POINTS,
  type AttachmentViewer,
  type AttachmentViewerProps,
  type MarkdownAttachmentProps,
} from "../../_shared/points.js";
import { extensionOf, viewKey } from "./kinds.js";

export interface FileMeta {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

interface FileBytes {
  readonly blob: Blob;
  readonly url: string;
}

export interface Viewers {
  /** Every viewer claiming `extension`, the default first. */
  candidates(extension: string): readonly AttachmentViewer[];
  /** The one that shows `extension` now, with its owner for error attribution. */
  resolve(extension: string): { readonly viewer: AttachmentViewer; readonly pluginId: string } | undefined;
  /** Every extension some viewer claims. */
  extensions(): readonly string[];
  subscribe(listener: () => void): () => void;
}

export function createViewers(
  kernel: Kernel,
  point: ExtensionPoint<AttachmentViewer>,
  read: (key: string) => SettingsValue | undefined,
): Viewers {
  const claiming = (extension: string) =>
    [...point.entries()]
      .filter((entry) => entry.value.extensions.includes(extension))
      .sort((a, b) => (a.value.order ?? 100) - (b.value.order ?? 100));

  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };
  point.subscribe(notify);
  try {
    kernel.settings.subscribe(notify);
  } catch {
    // Choices made elsewhere show after a reload instead.
  }

  return {
    candidates: (extension) => claiming(extension).map((entry) => entry.value),
    resolve: (extension) => {
      const entries = claiming(extension);
      const chosen = read(viewKey(extension));
      const entry = entries.find((candidate) => candidate.value.id === chosen) ?? entries[0];
      return entry ? { viewer: entry.value, pluginId: entry.pluginId } : undefined;
    },
    extensions: () => [...new Set(point.get().flatMap((viewer) => viewer.extensions))].sort(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function createAttachmentView(kernel: Kernel, viewers: Viewers): ComponentType<MarkdownAttachmentProps> {
  const metas = new Map<string, Promise<FileMeta | null>>();
  const bytes = new Map<string, Promise<FileBytes | null>>();
  const bounded = new WeakMap<ComponentType<AttachmentViewerProps>, ComponentType<AttachmentViewerProps>>();

  /** A failure is not cached: offline now is not offline forever. */
  const cached = <T,>(cache: Map<string, Promise<T | null>>, id: string, load: () => Promise<T>) => {
    const hit = cache.get(id);
    if (hit) return hit;
    const pending = load().catch((error: unknown) => {
      kernel.log.debug("attachment not available", { id, error });
      cache.delete(id);
      return null;
    });
    cache.set(id, pending);
    return pending;
  };

  const loadMeta = (id: string) =>
    cached(metas, id, async () => {
      const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(id)}/meta`, { headers: { [OFFLINE_COPY_HEADER]: "1" } });
      const body = (await response.json()) as Partial<FileMeta>;
      return { name: body.name ?? id, mime: body.mime ?? "", size: body.size ?? 0 };
    });

  const loadBytes = (id: string) =>
    cached(bytes, id, async () => {
      const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(id)}`, { headers: { [OFFLINE_COPY_HEADER]: "1" } });
      const blob = await response.blob();
      return { blob, url: URL.createObjectURL(blob) };
    });

  const guard = (viewer: AttachmentViewer, pluginId: string): ComponentType<AttachmentViewerProps> => {
    let component = bounded.get(viewer.component);
    if (!component) {
      component = kernel.ui.boundary(viewer.component, { point: POINTS.attachmentViewer, pluginId });
      bounded.set(viewer.component, component);
    }
    return component;
  };

  let version = 0;
  viewers.subscribe(() => {
    version += 1;
  });

  return function AttachmentView({ id, placement, fallback, frame }: MarkdownAttachmentProps): ReactNode {
    useSyncExternalStore(viewers.subscribe, () => version);

    const [meta, setMeta] = useState<FileMeta | null | undefined>(undefined);
    useEffect(() => {
      let live = true;
      setMeta(undefined);
      void loadMeta(id).then((value) => {
        if (live) setMeta(value);
      });
      return () => {
        live = false;
      };
    }, [id]);

    const extension = meta ? extensionOf(meta.name, meta.mime) : undefined;
    const choice = extension ? viewers.resolve(extension) : undefined;

    const [file, setFile] = useState<FileBytes | null | undefined>(undefined);
    const wanted = choice !== undefined;
    useEffect(() => {
      if (!wanted) return undefined;
      let live = true;
      void loadBytes(id).then((value) => {
        if (live) setFile(value);
      });
      return () => {
        live = false;
      };
    }, [id, wanted]);

    if (meta === undefined || (choice && file === undefined)) {
      return (
        <span className="attachments:italic attachments:text-text-muted" aria-busy="true" title={`attachment://${id}`}>
          loading file…
        </span>
      );
    }
    if (!meta || !choice || !file) return fallback;

    const View = guard(choice.viewer, choice.pluginId);
    return frame(
      <View
        file={{ id, name: meta.name, mime: meta.mime, size: meta.size }}
        blob={file.blob}
        url={file.url}
        placement={placement}
      />,
    );
  };
}
