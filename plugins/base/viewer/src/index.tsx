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
 *   header is display-only; `properties` and edit mode remain the two ways to change a
 *   value, and both plugins type values through `_shared/fm-display.ts` so they cannot
 *   disagree about what a key is.
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

const READER_CLASSES = "mx-auto w-full min-w-0 max-w-[72ch] break-words px-4 py-6 text-base leading-[1.65] compact:py-4 compact:leading-[1.7] [&>:first-child]:mt-0 [&_h1]:mb-2 [&_h1]:mt-6 [&_h1]:text-2xl [&_h1]:leading-tight compact:[&_h1]:text-xl [&_h2]:mb-2 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:leading-tight compact:[&_h2]:text-lg [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:leading-tight compact:[&_h3]:text-base [&_h4]:mb-2 [&_h4]:mt-6 [&_h4]:leading-tight [&_p]:mb-3 [&_p]:mt-0 [&_ul]:mb-3 [&_ol]:mb-3 [&_blockquote]:mb-3 [&_blockquote]:border-l-[3px] [&_blockquote]:border-border-strong [&_blockquote]:pl-3 [&_blockquote]:text-text-muted [&_pre]:mb-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:border-border [&_pre]:bg-bg-subtle [&_pre]:p-2 [&_table]:mb-3 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_a]:break-words [&_a]:text-link [&_code]:break-words [&_code]:rounded-[3px] [&_code]:bg-bg-subtle [&_code]:px-[0.3em] [&_code]:py-[0.1em] [&_code]:font-mono [&_code]:text-[0.9em] [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_img]:h-auto [&_img]:max-w-full [&_img]:rounded [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:text-left [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-border";

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
        <div className="max-w-[62ch] min-w-0 px-4 py-6 font-sans text-text-muted">
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
      <div className="w-full min-w-0 font-sans text-text">
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
    <div className="flex min-w-0 justify-center p-4 font-sans text-text compact:p-2">
      <figure className="m-0 flex max-w-[min(100%,72ch)] flex-col gap-2">
        <PreviewBody kind={kind} state={state} name={name} />
        <figcaption className="flex flex-col gap-0.5 text-sm">
          <span className="break-words font-semibold">{name}</span>
          <span className="text-sm text-text-muted">
            {meta?.mime ?? "unknown type"} · {formatBytes(meta?.size)}
            {meta?.revision !== undefined ? ` · revision ${meta.revision}` : ""}
          </span>
          <span className="mt-1">
            {/* A same-origin link, so the server's Content-Disposition decides whether
                it opens or downloads — the allowlist of safe inline types is the
                server's call, not this plugin's (SPEC §3.6). */}
            <a className="tap-h inline-flex items-center text-link focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus" href={apiUrl(reference.id)} target="_blank" rel="noreferrer">
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
      <div className="flex min-h-48 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong bg-bg-subtle p-6 text-center" aria-busy="true">
        <p className="text-sm text-text-muted">Loading the file…</p>
      </div>
    );
  }

  if (state.phase === "unavailable") {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong bg-bg-subtle p-6 text-center">
        <p className="m-0 inline-block rounded-full border border-warning bg-bg-raised px-2.5 py-0.5 text-xs text-text">
          {state.offline ? "Not available offline" : "This file could not be loaded"}
        </p>
        <p className="text-sm text-text-muted">{state.reason}</p>
      </div>
    );
  }

  if (state.phase === "skipped") {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong bg-bg-subtle p-6 text-center">
        <p className="m-0 inline-block rounded-full border border-border-strong bg-bg-raised px-2.5 py-0.5 text-xs text-text-muted">No inline preview</p>
        <p className="text-sm text-text-muted">{state.reason}.</p>
      </div>
    );
  }

  if (state.phase === "text") {
    return <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded border border-border bg-bg-subtle p-2 font-mono text-sm leading-[1.5]">{state.content}</pre>;
  }

  switch (kind) {
    case "image":
      return <img className="mx-auto block h-auto max-h-[70vh] max-w-full rounded-lg bg-bg-subtle shadow-1" src={state.url} alt={name} />;
    case "audio":
      return <audio className="w-full rounded" controls src={state.url} />;
    case "video":
      return <video className="w-full rounded" controls src={state.url} />;
    case "pdf":
      return (
        <div className="flex min-h-48 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong bg-bg-subtle p-6 text-center">
          <p className="m-0 inline-block rounded-full border border-border-strong bg-bg-raised px-2.5 py-0.5 text-xs text-text-muted">PDF</p>
          <p className="text-sm text-text-muted">PDFs cannot be shown inline. Open the file instead.</p>
        </div>
      );
    default:
      return (
        <div className="flex min-h-48 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border-strong bg-bg-subtle p-6 text-center">
          <p className="m-0 inline-block rounded-full border border-border-strong bg-bg-raised px-2.5 py-0.5 text-xs text-text-muted">File</p>
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
