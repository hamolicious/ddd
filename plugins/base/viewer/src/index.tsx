/**
 * `viewer` — read mode (SPEC §6.5).
 *
 * One contribution to `document.mode`, and two responsibilities inside it:
 *
 * - **Hide the machine regions.** The frontmatter block and the `%%%` sections are part
 *   of the text (SPEC §3.1) and must not be rendered as prose. Reading mode shows the
 *   body; `properties` shows the frontmatter as fields. The split itself is
 *   `markdown.bodyOf` — the byte-exact fence rules of SPEC §3.4 live in the shared Rust
 *   core, and a second implementation here is exactly the divergence SPEC §2 forbids.
 * - **Render an attachment wrapper document as a file preview** (SPEC §3.6). A wrapper
 *   is an ordinary document whose body embeds one `attachment://`, so this is a
 *   presentation decision, not a special object type. See `wrapper.ts`.
 *
 * It renders from `row.content` — the projection — so a document is readable offline
 * and before hydration finishes. The hydrated handle is only needed for editing.
 *
 * **Blobs are fetched through `kernel.session.fetch`, not put in a `src`.** A bare
 * `/api/attachments/<id>` in an `<img>` carries cookies in a browser and *nothing* in
 * the Flutter shell, which authenticates with a bearer token (SPEC §5.2) — the image
 * would silently 401 on Android only. Fetching and holding an object URL works under
 * both carriers and gives an honest "not available offline" state for free.
 */

import type { Kernel } from "@kernel";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { POINTS, type DocumentMode, type DocumentModeProps } from "../../_shared/points.js";
import {
  formatBytes,
  previewKindFor,
  wrapperAttachmentOf,
  type AttachmentReference,
  type PreviewKind,
} from "./wrapper.js";

/** The `markdown` plugin's API, structurally — plugins never import each other (SPEC §6.1). */
interface MarkdownApi {
  render(text: string, options?: { readonly documentId?: string }): ReactNode;
  bodyOf(text: string): string;
}

interface AttachmentMeta {
  readonly id?: string;
  readonly name?: string;
  readonly mime?: string;
  readonly size?: number;
  readonly revision?: number;
}

/** Inline-preview budgets. Beyond them a file is a chip with actions, not a preview. */
const MAX_INLINE_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 256 * 1024;

export default function activate(kernel: Kernel): void {
  const markdown = kernel.services.require<MarkdownApi>("markdown");

  const Read = ({ id, row }: DocumentModeProps): ReactNode => {
    const text = row.content;
    const body = useMemo(() => (text === undefined ? undefined : safeBodyOf(kernel, markdown, text)), [text]);
    const wrapper = useMemo(() => (body === undefined ? undefined : wrapperAttachmentOf(body)), [body]);

    if (text === undefined) {
      // The projection carries `content` for every replicated document (SPEC §4.1), so
      // this is the narrow window before the first sync completes — or a client that
      // learned of the document from a link before its row arrived.
      return (
        <div className="viewer-root viewer-empty">
          <p>This document’s text has not reached this device yet.</p>
        </div>
      );
    }

    if (wrapper) {
      return <AttachmentPreview kernel={kernel} reference={wrapper} title={row.title} />;
    }

    return (
      <article className="viewer-root viewer-body">
        {markdown.render(body ?? "", { documentId: id })}
      </article>
    );
  };

  kernel.extensions.contribute<DocumentMode>(POINTS.documentMode, {
    id: "read",
    label: "Read",
    order: 0,
    component: Read,
  });
}

/**
 * `markdown.bodyOf` is another plugin's code. A throw from it must cost the reader the
 * hidden frontmatter, not the whole document.
 */
function safeBodyOf(kernel: Kernel, markdown: MarkdownApi, text: string): string {
  try {
    return markdown.bodyOf(text);
  } catch (error) {
    kernel.log.error("markdown.bodyOf threw; showing the raw text", error);
    return text;
  }
}

// ---------------------------------------------------------------------------
// the wrapper-document preview (SPEC §3.6)
// ---------------------------------------------------------------------------

type BlobState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly url: string }
  | { readonly phase: "text"; readonly content: string }
  | { readonly phase: "skipped"; readonly reason: string }
  | { readonly phase: "unavailable"; readonly offline: boolean; readonly reason: string };

function AttachmentPreview({
  kernel,
  reference,
  title,
}: {
  readonly kernel: Kernel;
  readonly reference: AttachmentReference;
  readonly title: string;
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
        const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(reference.id)}/meta`);
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
      // Audio and video are streamed from the API URL rather than a blob: the CSP of
      // SPEC §8 allows `blob:` for `img-src` only, and `media-src` falls back to
      // `default-src 'self'`. See the INTEGRATION note in this plugin's README section.
      if (kind === "audio" || kind === "video" || kind === "pdf") {
        setState({ phase: "ready", url: apiUrl(reference.id) });
        return;
      }

      try {
        const response = await kernel.session.fetch(`/attachments/${encodeURIComponent(reference.id)}`);
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
  const name = meta?.name ?? reference.label ?? title;

  return (
    <div className="viewer-root viewer-attachment">
      <figure className="viewer-preview">
        <PreviewBody kind={kind} state={state} name={name} />
        <figcaption className="viewer-file">
          <span className="viewer-file-name">{name}</span>
          <span className="viewer-file-meta">
            {meta?.mime ?? "unknown type"} · {formatBytes(meta?.size)}
            {meta?.revision !== undefined ? ` · revision ${meta.revision}` : ""}
          </span>
          <span className="viewer-file-actions">
            {/* A same-origin link, so the server's Content-Disposition decides whether
                it opens or downloads — the allowlist of safe inline types is the
                server's call, not this plugin's (SPEC §3.6). */}
            <a className="viewer-file-link" href={apiUrl(reference.id)} target="_blank" rel="noreferrer">
              Open the file
            </a>
          </span>
        </figcaption>
      </figure>
    </div>
  );
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
      <div className="viewer-preview-frame" aria-busy="true">
        <p className="viewer-muted">Loading the file…</p>
      </div>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <div className="viewer-preview-frame">
        <p className="viewer-chip viewer-chip-offline">
          {state.offline ? "Not available offline" : "This file could not be loaded"}
        </p>
        <p className="viewer-muted">{state.reason}</p>
      </div>
    );
  }

  if (state.phase === "skipped") {
    return (
      <div className="viewer-preview-frame">
        <p className="viewer-chip">No inline preview</p>
        <p className="viewer-muted">{state.reason}.</p>
      </div>
    );
  }

  if (state.phase === "text") {
    return <pre className="viewer-preview-text">{state.content}</pre>;
  }

  switch (kind) {
    case "image":
      return <img className="viewer-preview-image" src={state.url} alt={name} />;
    case "audio":
      return <audio className="viewer-preview-media" controls src={state.url} />;
    case "video":
      return <video className="viewer-preview-media" controls src={state.url} />;
    case "pdf":
      return (
        <div className="viewer-preview-frame">
          <p className="viewer-chip">PDF</p>
          <p className="viewer-muted">PDFs cannot be shown inline. Open the file instead.</p>
        </div>
      );
    default:
      return (
        <div className="viewer-preview-frame">
          <p className="viewer-chip">File</p>
        </div>
      );
  }
}

/**
 * The API is same-origin, so `'self'` in the CSP covers it and the browser attaches the
 * session cookie. Used only for links and streamed media — never for the primary image
 * path, which goes through `session.fetch` so the shell's bearer token works too.
 */
const apiUrl = (id: string): string => `/api/attachments/${encodeURIComponent(id)}`;

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}
