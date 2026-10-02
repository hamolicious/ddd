import { OFFLINE_COPY_HEADER, OfflineCopyNote, OfflineCopyState, offlineCopies } from "../../_shared/offline-copy.js";
import type { Kernel } from "@kernel";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { addCommand } from "plugin:commands";
import { addMode, currentDocument, currentRow, type DocumentModeProps } from "plugin:document-surface";
import { bodyOf, render, renderAttachment, renderDocLink, type MarkdownRenderer } from "plugin:markdown";
import { addRoute } from "plugin:router";
import { addView } from "plugin:shell-ui";

import { ChildrenFooter, type ChildrenSource } from "./ChildrenFooter.js";
import { FmHeader } from "./FmHeader.js";
import { FULL_WIDTH_KEY, columnClasses, isFullWidth } from "./width.js";
import {
  formatBytes,
  previewKindFor,
  wrapperAttachmentOf,
  type AttachmentReference,
  type PreviewKind,
} from "./wrapper.js";

type MarkdownApi = Pick<MarkdownRenderer, "render" | "bodyOf" | "renderAttachment" | "renderDocLink">;

interface AttachmentMeta {
  readonly id?: string;
  readonly name?: string;
  readonly mime?: string;
  readonly size?: number;
  readonly revision?: number;
}

const MAX_INLINE_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 256 * 1024;

const READER_CLASSES = "viewer:mx-auto viewer:w-full viewer:min-w-0 viewer:break-words viewer:py-6 viewer:text-base viewer:leading-[1.65] viewer:compact:py-4 viewer:compact:leading-[1.7] viewer:[&>:first-child]:mt-0 viewer:[&_h1]:mb-2 viewer:[&_h1]:mt-6 viewer:[&_h1]:text-2xl viewer:[&_h1]:leading-tight viewer:compact:[&_h1]:text-xl viewer:[&_h2]:mb-2 viewer:[&_h2]:mt-6 viewer:[&_h2]:text-xl viewer:[&_h2]:leading-tight viewer:compact:[&_h2]:text-lg viewer:[&_h3]:mb-2 viewer:[&_h3]:mt-6 viewer:[&_h3]:text-lg viewer:[&_h3]:leading-tight viewer:compact:[&_h3]:text-base viewer:[&_h4]:mb-2 viewer:[&_h4]:mt-6 viewer:[&_h4]:leading-tight viewer:[&_p]:mb-3 viewer:[&_p]:mt-0 viewer:[&_ul]:mb-3 viewer:[&_ol]:mb-3 viewer:[&_blockquote]:mb-3 viewer:[&_blockquote]:border-l-[3px] viewer:[&_blockquote]:border-border-strong viewer:[&_blockquote]:pl-3 viewer:[&_blockquote]:text-text-muted viewer:[&_pre]:mb-3 viewer:[&_pre]:max-w-full viewer:[&_pre]:overflow-x-auto viewer:[&_pre]:rounded viewer:[&_pre]:border viewer:[&_pre]:border-border viewer:[&_pre]:bg-bg-subtle viewer:[&_pre]:p-2 viewer:[&_table]:mb-3 viewer:[&_table]:block viewer:[&_table]:max-w-full viewer:[&_table]:overflow-x-auto viewer:[&_table]:border-collapse viewer:[&_a]:break-words viewer:[&_a]:text-link viewer:[&_code]:break-words viewer:[&_code]:rounded-[3px] viewer:[&_code]:bg-bg-subtle viewer:[&_code]:px-[0.3em] viewer:[&_code]:py-[0.1em] viewer:[&_code]:font-mono viewer:[&_code]:text-[0.9em] viewer:[&_pre_code]:bg-transparent viewer:[&_pre_code]:p-0 viewer:[&_img]:h-auto viewer:[&_img]:max-w-full viewer:[&_img]:rounded viewer:[&_th]:border viewer:[&_th]:border-border viewer:[&_th]:px-2 viewer:[&_th]:py-1 viewer:[&_th]:text-left viewer:[&_td]:border viewer:[&_td]:border-border viewer:[&_td]:px-2 viewer:[&_td]:py-1 viewer:[&_td]:text-left viewer:[&_hr]:border-0 viewer:[&_hr]:border-t viewer:[&_hr]:border-border";

export default async function activate(kernel: Kernel): Promise<void> {
  const markdown: MarkdownApi = { render, bodyOf, renderAttachment, renderDocLink };
  const tree: ChildrenSource | undefined = await kernel.plugins
    .optional<typeof import("plugin:folders")>("folders")
    .catch((cause: unknown) => {
      kernel.log.warn("viewer: folders could not be loaded; no list of notes inside", cause);
      return undefined;
    });

  const Read = ({ id, row }: DocumentModeProps): ReactNode => {
    const text = row.content;
    const body = useMemo(() => (text === undefined ? undefined : safeBodyOf(kernel, markdown, text)), [text]);
    const wrapper = useMemo(() => (body === undefined ? undefined : wrapperAttachmentOf(body)), [body]);
    const fullWidth = isFullWidth(row.fm);

    if (text === undefined) {
      return (
        <div className="viewer:max-w-[62ch] viewer:min-w-0 viewer:px-4 viewer:py-6 viewer:font-sans viewer:text-text-muted">
          <p>This document’s text has not reached this device yet.</p>
        </div>
      );
    }

    if (wrapper) {
      return <AttachmentPreview kernel={kernel} markdown={markdown} reference={wrapper} title={row.title} />;
    }

    return (
      <div className="viewer:w-full viewer:min-w-0 viewer:font-sans viewer:text-text">
        <FmHeader fm={row.fm} fmParseError={row.fm_parse_error} renderDocLink={markdown.renderDocLink} fullWidth={fullWidth} />
        <article className={`${READER_CLASSES} ${columnClasses(fullWidth)}`}>{markdown.render(body ?? "", { documentId: id })}</article>
        {tree ? <ChildrenFooter id={id} folders={tree} renderDocLink={markdown.renderDocLink} divided={body?.trim() !== ""} fullWidth={fullWidth} /> : null}
      </div>
    );
  };

  addMode({
    id: "read",
    label: "Read",
    order: 0,
    icon: (
      <svg aria-hidden="true" viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 7c-1.5-1.3-4-2-7.5-2v12c3.5 0 6 .7 7.5 2 1.5-1.3 4-2 7.5-2V5c-3.5 0-6 .7-7.5 2z" />
        <path d="M12 7v12" />
      </svg>
    ),
    component: Read,
  });

  addCommand({
    id: "viewer.toggleFullWidth",
    title: "Toggle full width",
    category: "Document",
    icon: "arrows-horizontal",
    when: () => currentDocument() !== undefined,
    run: async () => {
      const id = currentDocument();
      if (id === undefined) return;
      const splice = kernel.documents.splice;
      try {
        if (isFullWidth(currentRow()?.fm)) await splice.removeFrontmatterKey(id, FULL_WIDTH_KEY);
        else await splice.setFrontmatterValue(id, FULL_WIDTH_KEY, true);
      } catch (error) {
        kernel.log.error("viewer: toggling full width failed", { id, error });
        kernel.ui.notify({
          id: `viewer.full-width.${id}`,
          level: "error",
          message: "Could not change this note's width.",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });

  const File = ({ params }: { readonly params?: Readonly<Record<string, string>> }): ReactNode => {
    const id = params?.["id"] ?? "";
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      return (
        <div className="viewer:max-w-[62ch] viewer:min-w-0 viewer:px-4 viewer:py-6 viewer:font-sans viewer:text-text-muted">
          <p>That is not a file address.</p>
        </div>
      );
    }
    return <AttachmentPreview key={id} kernel={kernel} markdown={markdown} reference={{ id, embedded: true }} title="File" />;
  };
  addRoute({ path: "/file/:id", view: "viewer.file" });
  addView({ id: "viewer.file", title: "File", component: File });
}

function safeBodyOf(kernel: Kernel, markdown: MarkdownApi, text: string): string {
  try {
    return markdown.bodyOf(text);
  } catch (error) {
    kernel.log.error("markdown.bodyOf threw; showing the raw text", error);
    return text;
  }
}

type BlobState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly url: string }
  | { readonly phase: "text"; readonly content: string }
  | { readonly phase: "skipped"; readonly reason: string }
  | { readonly phase: "unavailable"; readonly offline: boolean; readonly reason: string };

function AttachmentPreview({
  kernel,
  markdown,
  reference,
  title,
}: {
  readonly kernel: Kernel;
  readonly markdown: MarkdownApi;
  readonly reference: AttachmentReference;
  readonly title: string;
}): ReactNode {
  const [meta, setMeta] = useState<AttachmentMeta | undefined>(undefined);
  const [offline] = useState(() => new OfflineCopyState());

  useEffect(() => {
    let cancelled = false;
    offlineCopies((path, init) => kernel.session.fetch(path, init), offline)(
      `/attachments/${encodeURIComponent(reference.id)}/meta`,
    )
      .then((response) => response.json() as Promise<AttachmentMeta>)
      .then((resolved) => {
        if (!cancelled) setMeta(resolved);
      })
      .catch(() => {
      });
    return () => {
      cancelled = true;
    };
  }, [kernel, offline, reference.id]);

  const name = meta?.name ?? reference.label ?? title;
  const own = <OwnPreview kernel={kernel} reference={reference} name={name} />;
  let body: ReactNode = own;
  try {
    body = markdown.renderAttachment(reference.id, { placement: "page", alt: name, fallback: own }) ?? own;
  } catch (error) {
    kernel.log.error("markdown.renderAttachment threw; showing the built-in preview", error);
  }

  return (
    <div className="viewer:flex viewer:min-w-0 viewer:justify-center viewer:p-4 viewer:font-sans viewer:text-text viewer:compact:p-2">
      <figure className="viewer:m-0 viewer:flex viewer:w-full viewer:max-w-[min(100%,72ch)] viewer:flex-col viewer:gap-2">
        {body}
        <OfflineCopyNote
          state={offline}
          className="viewer:m-0 viewer:rounded viewer:border viewer:border-warning viewer:px-2 viewer:py-1 viewer:text-sm viewer:text-text-muted"
        />
        <figcaption className="viewer:flex viewer:flex-col viewer:gap-0.5 viewer:text-sm">
          <span className="viewer:break-words viewer:font-semibold">{name}</span>
          <span className="viewer:text-sm viewer:text-text-muted">
            {meta?.mime ?? "unknown type"} · {formatBytes(meta?.size)}
            {meta?.revision !== undefined ? ` · revision ${meta.revision}` : ""}
          </span>
          <span className="viewer:mt-1">
            <a className="viewer:tap-h viewer:inline-flex viewer:items-center viewer:text-link viewer:focus-visible:outline-2 viewer:focus-visible:outline-offset-2 viewer:focus-visible:outline-focus" href={apiUrl(reference.id)} target="_blank" rel="noreferrer">
              Open the file
            </a>
          </span>
        </figcaption>
      </figure>
    </div>
  );
}

function OwnPreview({
  kernel,
  reference,
  name,
}: {
  readonly kernel: Kernel;
  readonly reference: AttachmentReference;
  readonly name: string;
}): ReactNode {
  const [meta, setMeta] = useState<AttachmentMeta | undefined>(undefined);
  const [state, setState] = useState<BlobState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;

    const fail = (error: unknown): void => {
      if (cancelled) return;
      setState({
        phase: "unavailable",
        offline: kernel.sync.state.status === "offline",
        reason: describe(error),
      });
    };

    void (async () => {
      let resolved: AttachmentMeta | undefined;
      try {
        const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(reference.id)}/meta`, { headers: { [OFFLINE_COPY_HEADER]: "1" } });
        resolved = (await response.json()) as AttachmentMeta;
        if (cancelled) return;
        setMeta(resolved);
      } catch (error) {
        fail(error);
        return;
      }

      const kind = previewKindFor(resolved?.mime);
      const size = resolved?.size;
      if (kind === "file") {
        setState({ phase: "skipped", reason: "this file type has no inline preview" });
        return;
      }
      if (kind === "image" && size !== undefined && size > MAX_INLINE_IMAGE_BYTES) {
        setState({ phase: "skipped", reason: "the image is too large to preview inline" });
        return;
      }
      if (kind === "text" && size !== undefined && size > MAX_INLINE_TEXT_BYTES) {
        setState({ phase: "skipped", reason: "the file is too long to preview inline" });
        return;
      }
      if (kind === "audio" || kind === "video" || kind === "pdf") {
        setState({ phase: "ready", url: apiUrl(reference.id) });
        return;
      }

      try {
        const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(reference.id)}`, { headers: { [OFFLINE_COPY_HEADER]: "1" } });
        if (kind === "text") {
          const content = await response.text();
          if (cancelled) return;
          setState({ phase: "text", content });
          return;
        }
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ phase: "ready", url: objectUrl });
      } catch (error) {
        fail(error);
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [kernel, reference.id]);

  const kind = previewKindFor(meta?.mime);
  return <PreviewBody kind={kind} state={state} name={name} />;
}

function PreviewBody({
  kind,
  state,
  name,
}: {
  readonly kind: PreviewKind;
  readonly state: BlobState;
  readonly name: string;
}): ReactNode {
  if (state.phase === "loading") {
    return (
      <div className="viewer:flex viewer:min-h-48 viewer:flex-col viewer:items-center viewer:justify-center viewer:gap-1 viewer:rounded-lg viewer:border viewer:border-dashed viewer:border-border-strong viewer:bg-bg-subtle viewer:p-6 viewer:text-center" aria-busy="true">
        <p className="viewer:text-sm viewer:text-text-muted">Loading the file…</p>
      </div>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <div className="viewer:flex viewer:min-h-48 viewer:flex-col viewer:items-center viewer:justify-center viewer:gap-1 viewer:rounded-lg viewer:border viewer:border-dashed viewer:border-border-strong viewer:bg-bg-subtle viewer:p-6 viewer:text-center">
        <p className="viewer:m-0 viewer:inline-block viewer:rounded-full viewer:border viewer:border-warning viewer:bg-bg-raised viewer:px-2.5 viewer:py-0.5 viewer:text-xs viewer:text-text">
          {state.offline ? "Not available offline" : "This file could not be loaded"}
        </p>
        <p className="viewer:text-sm viewer:text-text-muted">{state.reason}</p>
      </div>
    );
  }

  if (state.phase === "skipped") {
    return (
      <div className="viewer:flex viewer:min-h-48 viewer:flex-col viewer:items-center viewer:justify-center viewer:gap-1 viewer:rounded-lg viewer:border viewer:border-dashed viewer:border-border-strong viewer:bg-bg-subtle viewer:p-6 viewer:text-center">
        <p className="viewer:m-0 viewer:inline-block viewer:rounded-full viewer:border viewer:border-border-strong viewer:bg-bg-raised viewer:px-2.5 viewer:py-0.5 viewer:text-xs viewer:text-text-muted">No inline preview</p>
        <p className="viewer:text-sm viewer:text-text-muted">{state.reason}.</p>
      </div>
    );
  }

  if (state.phase === "text") {
    return <pre className="viewer:max-h-[70vh] viewer:overflow-auto viewer:whitespace-pre-wrap viewer:rounded viewer:border viewer:border-border viewer:bg-bg-subtle viewer:p-2 viewer:font-mono viewer:text-sm viewer:leading-[1.5]">{state.content}</pre>;
  }

  switch (kind) {
    case "image":
      return <img className="viewer:mx-auto viewer:block viewer:h-auto viewer:max-h-[70vh] viewer:max-w-full viewer:rounded-lg viewer:bg-bg-subtle viewer:shadow-1" src={state.url} alt={name} />;
    case "audio":
      return <audio className="viewer:w-full viewer:rounded" controls src={state.url} />;
    case "video":
      return <video className="viewer:w-full viewer:rounded" controls src={state.url} />;
    case "pdf":
      return (
        <div className="viewer:flex viewer:min-h-48 viewer:flex-col viewer:items-center viewer:justify-center viewer:gap-1 viewer:rounded-lg viewer:border viewer:border-dashed viewer:border-border-strong viewer:bg-bg-subtle viewer:p-6 viewer:text-center">
          <p className="viewer:m-0 viewer:inline-block viewer:rounded-full viewer:border viewer:border-border-strong viewer:bg-bg-raised viewer:px-2.5 viewer:py-0.5 viewer:text-xs viewer:text-text-muted">PDF</p>
          <p className="viewer:text-sm viewer:text-text-muted">PDFs cannot be shown inline. Open the file instead.</p>
        </div>
      );
    default:
      return (
        <div className="viewer:flex viewer:min-h-48 viewer:flex-col viewer:items-center viewer:justify-center viewer:gap-1 viewer:rounded-lg viewer:border viewer:border-dashed viewer:border-border-strong viewer:bg-bg-subtle viewer:p-6 viewer:text-center">
          <p className="viewer:m-0 viewer:inline-block viewer:rounded-full viewer:border viewer:border-border-strong viewer:bg-bg-raised viewer:px-2.5 viewer:py-0.5 viewer:text-xs viewer:text-text-muted">File</p>
        </div>
      );
  }
}

const apiUrl = (id: string): string => `/api/attachments/${encodeURIComponent(id)}`;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
