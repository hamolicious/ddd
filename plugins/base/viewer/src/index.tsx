/**
 * `viewer` — read mode (SPEC §6.5).
 *
 * One contribution to `document.mode`, and three responsibilities inside it:
 *
 * - **Hide the machine regions.** The frontmatter block and the `%%%` sections are part
 *   of the text (SPEC §3.1) and must not be rendered as prose. Reading mode shows the
 *   body. The split itself is `markdown.bodyOf` — the byte-exact fence rules of SPEC
 *   §3.4 live in the shared Rust core, and a second implementation here is exactly the
 *   divergence SPEC §2 forbids.
 * - **Show the frontmatter's *contents* as a pretty header** above the body
 *   (`FmHeader.tsx`). Hiding the block is right about the text and was wrong about the
 *   information: the date, the tags and the folder are things a reader wants, and the
 *   only place they appeared was a sidebar panel that is a drawer on a phone. The
 *   header is display-only; edit mode is the way to change a value. Values are typed
 *   through `_shared/fm-display.ts` so any plugin that shows `fm` agrees on what a
 *   key is.
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
import { FmHeader } from "./FmHeader.js";
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

const READER_CLASSES = "viewer:mx-auto viewer:w-full viewer:min-w-0 viewer:max-w-[72ch] viewer:break-words viewer:px-4 viewer:py-6 viewer:text-base viewer:leading-[1.65] viewer:compact:py-4 viewer:compact:leading-[1.7] viewer:[&>:first-child]:mt-0 viewer:[&_h1]:mb-2 viewer:[&_h1]:mt-6 viewer:[&_h1]:text-2xl viewer:[&_h1]:leading-tight viewer:compact:[&_h1]:text-xl viewer:[&_h2]:mb-2 viewer:[&_h2]:mt-6 viewer:[&_h2]:text-xl viewer:[&_h2]:leading-tight viewer:compact:[&_h2]:text-lg viewer:[&_h3]:mb-2 viewer:[&_h3]:mt-6 viewer:[&_h3]:text-lg viewer:[&_h3]:leading-tight viewer:compact:[&_h3]:text-base viewer:[&_h4]:mb-2 viewer:[&_h4]:mt-6 viewer:[&_h4]:leading-tight viewer:[&_p]:mb-3 viewer:[&_p]:mt-0 viewer:[&_ul]:mb-3 viewer:[&_ol]:mb-3 viewer:[&_blockquote]:mb-3 viewer:[&_blockquote]:border-l-[3px] viewer:[&_blockquote]:border-border-strong viewer:[&_blockquote]:pl-3 viewer:[&_blockquote]:text-text-muted viewer:[&_pre]:mb-3 viewer:[&_pre]:max-w-full viewer:[&_pre]:overflow-x-auto viewer:[&_pre]:rounded viewer:[&_pre]:border viewer:[&_pre]:border-border viewer:[&_pre]:bg-bg-subtle viewer:[&_pre]:p-2 viewer:[&_table]:mb-3 viewer:[&_table]:block viewer:[&_table]:max-w-full viewer:[&_table]:overflow-x-auto viewer:[&_table]:border-collapse viewer:[&_a]:break-words viewer:[&_a]:text-link viewer:[&_code]:break-words viewer:[&_code]:rounded-[3px] viewer:[&_code]:bg-bg-subtle viewer:[&_code]:px-[0.3em] viewer:[&_code]:py-[0.1em] viewer:[&_code]:font-mono viewer:[&_code]:text-[0.9em] viewer:[&_pre_code]:bg-transparent viewer:[&_pre_code]:p-0 viewer:[&_img]:h-auto viewer:[&_img]:max-w-full viewer:[&_img]:rounded viewer:[&_th]:border viewer:[&_th]:border-border viewer:[&_th]:px-2 viewer:[&_th]:py-1 viewer:[&_th]:text-left viewer:[&_td]:border viewer:[&_td]:border-border viewer:[&_td]:px-2 viewer:[&_td]:py-1 viewer:[&_td]:text-left viewer:[&_hr]:border-0 viewer:[&_hr]:border-t viewer:[&_hr]:border-border";

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
        <div className="viewer:max-w-[62ch] viewer:min-w-0 viewer:px-4 viewer:py-6 viewer:font-sans viewer:text-text-muted">
          <p>This document’s text has not reached this device yet.</p>
        </div>
      );
    }

    if (wrapper) {
      return <AttachmentPreview kernel={kernel} reference={wrapper} title={row.title} />;
    }

    return (
      // The column, not the article: the properties header and the body share one
      // measure and one set of gutters, and `.viewer-body` keeps its own `max-width`
      // and auto margins so nothing about the reading column moves.
      <div className="viewer:w-full viewer:min-w-0 viewer:font-sans viewer:text-text">
        <FmHeader fm={row.fm} fmParseError={row.fm_parse_error} />
        <article className={READER_CLASSES}>{markdown.render(body ?? "", { documentId: id })}</article>
      </div>
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
    <div className="viewer:flex viewer:min-w-0 viewer:justify-center viewer:p-4 viewer:font-sans viewer:text-text viewer:compact:p-2">
      <figure className="viewer:m-0 viewer:flex viewer:max-w-[min(100%,72ch)] viewer:flex-col viewer:gap-2">
        <PreviewBody kind={kind} state={state} name={name} />
        <figcaption className="viewer:flex viewer:flex-col viewer:gap-0.5 viewer:text-sm">
          <span className="viewer:break-words viewer:font-semibold">{name}</span>
          <span className="viewer:text-sm viewer:text-text-muted">
            {meta?.mime ?? "unknown type"} · {formatBytes(meta?.size)}
            {meta?.revision !== undefined ? ` · revision ${meta.revision}` : ""}
          </span>
          <span className="viewer:mt-1">
            {/* A same-origin link, so the server's Content-Disposition decides whether
                it opens or downloads — the allowlist of safe inline types is the
                server's call, not this plugin's (SPEC §3.6). */}
            <a className="viewer:tap-h viewer:inline-flex viewer:items-center viewer:text-link viewer:focus-visible:outline-2 viewer:focus-visible:outline-offset-2 viewer:focus-visible:outline-focus" href={apiUrl(reference.id)} target="_blank" rel="noreferrer">
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
