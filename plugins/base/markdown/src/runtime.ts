/**
 * Everything the rendered tree needs from outside itself: the kernel, navigation,
 * attachment I/O, and the one write path.
 *
 * Collected behind an interface for two reasons. First, the React components below the
 * renderer get it as a plain object rather than reaching for `kernel` through a module
 * global — a plugin's kernel handle is per-plugin and attributed (SPEC §6.4), and passing
 * it explicitly keeps that visible. Second, it is the seam the tests substitute: the
 * pipeline suites render with a stub runtime and assert on the tree, with no IndexedDB,
 * no sockets and no `fetch`.
 */

import { embedReplace, embedToggle, type EmbedLocation } from "./embed-toggle.js";
import type { Kernel } from "@kernel";

import { regionsOf } from "../../_shared/regions.js";
import { resolveMarkerOffset, type TaskLocation, type TaskScan } from "./tasks.js";

/**
 * The `Y.Doc` transaction origin for a checkbox write.
 *
 * `y-codemirror.next` uses the transaction origin to tell its own edits from remote ones;
 * an editor that also renders task checkboxes (edit mode with a live preview) needs to
 * recognise this one so it does not echo the change back into the selection.
 */
export const TASK_SPLICE_ORIGIN = { plugin: "markdown", write: "taskState" } as const;
export const EMBED_SPLICE_ORIGIN = { plugin: "markdown", write: "embed" } as const;

/** The route pattern `document-surface` owns. See the INTEGRATION note in `activate`. */
export const DOC_ROUTE = "/doc/:id";

export interface AttachmentMeta {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly size: number;
}

/** A loaded attachment blob, as an object URL the DOM can use. */
export interface AttachmentBlob {
  readonly objectUrl: string;
  readonly mime: string;
}

export interface TaskWriteRequest {
  readonly documentId: string;
  /**
   * Absolute offset of the rendered text's first character in the document, when the
   * caller knows it. `undefined` means "the rendered text is this document's body", which
   * is what `viewer` does (`markdown.render(markdown.bodyOf(text))`) and is resolved
   * against the *current* text at write time rather than the text that was rendered.
   */
  readonly offset: number | undefined;
  /** What the renderer saw at this task's position. */
  readonly expected: TaskLocation;
  /** This task's index among all markers in the rendered text, in document order. */
  readonly ordinal: number;
  /** The marker to write. */
  readonly next: string;
  /** Re-locate every marker in a body, for the drifted-offset recovery path. */
  readonly rescan: (body: string) => TaskScan;
}

export interface MarkdownRuntime {
  readonly kernel: Kernel;
  /** Open a document in the app. */
  openDocument(id: string, fragment?: string | null): void;
  /** The target's title from the local projection — offline-correct (SPEC §4.1). */
  titleOf(id: string): Promise<string | undefined>;
  /** Attachment metadata over the authenticated session. */
  attachmentMeta(id: string): Promise<AttachmentMeta | null>;
  /** The attachment's bytes as an object URL, or `null` when unavailable. */
  attachmentBlob(id: string): Promise<AttachmentBlob | null>;
  /** Hand the viewer the file (SPEC §3.6 chips are downloadable). */
  downloadAttachment(id: string): Promise<void>;
  /** Remember which embedded attachment the user is acting on, for the palette command. */
  focusAttachment(id: string | null, site?: EmbedSite): void;
  focusedAttachment(): string | null;
  /** Where the focused attachment is embedded, when it came from a rendered document. */
  focusedSite(): EmbedSite | undefined;
  /**
   * {@link promote}, then, given where the file is embedded, replace that embed with a
   * link to the new document. Resolves to the new document's id either way.
   */
  promoteEmbed(attachmentId: string, site?: EmbedSite): Promise<string>;
  /** SPEC §3.6: create the wrapper document for an embedded attachment. */
  promote(attachmentId: string, options?: { readonly path?: string }): Promise<string>;
  /** The one checkbox write path: a validated single-character text splice. */
  writeTaskMarker(request: TaskWriteRequest): Promise<void>;
  /** Flip an embedded attachment between preview and link: add or remove its `!`. */
  toggleEmbed(request: EmbedToggleRequest): Promise<void>;
}

/** One embed in one document: what the toggle and promote write to. */
export interface EmbedSite {
  readonly documentId: string;
  /** As {@link TaskWriteRequest.offset}: `undefined` means "the rendered text is the body". */
  readonly offset: number | undefined;
  readonly location: EmbedLocation;
}

export type EmbedToggleRequest = EmbedSite;

/** `kernel.services.get("router")` — the slice of it this plugin uses. */
interface RouterLike {
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  href(pattern: string, params?: Readonly<Record<string, string>>): string;
}

/**
 * Inline types a browser may render from a blob URL.
 *
 * SPEC §3.6: "Never inline-serve `image/svg+xml` (stored-XSS vector)". The server enforces
 * that with `Content-Disposition`, and this is the client half of the same rule — an SVG
 * fetched into a blob and handed to `<img src>` would not execute (images are not a
 * scripted context), but it would execute the moment any code path opened that blob URL in
 * a tab, and "we happen not to do that yet" is not a security property. An SVG renders as
 * a chip.
 */
const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);

/** `true` when this MIME type may be shown inline as an image. */
export function isInlineImage(mime: string): boolean {
  return INLINE_IMAGE_TYPES.has(mime.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}

/**
 * Build the runtime over a real kernel.
 *
 * The caches are deliberate and the lifetime is the page:
 *
 * - **Metadata and blob promises are cached by id**, so a document embedding the same
 *   image twelve times fetches it once, and a re-render (every keystroke in edit mode
 *   with a preview) refetches nothing.
 * - **Object URLs are never revoked per component.** Revoking on unmount is the textbook
 *   answer and it is wrong here: React unmounts and remounts the tree on every render
 *   pass, so the URL would be revoked out from under the next `<img>` and the image would
 *   flicker or vanish. One URL per attachment for the life of the page, released by
 *   `dispose()` on plugin teardown, is the honest trade — bounded by the number of
 *   distinct attachments the user actually looked at.
 */
export function createRuntime(kernel: Kernel): MarkdownRuntime & { dispose(): void } {
  const router = kernel.services.get<RouterLike>("router");
  const metaCache = new Map<string, Promise<AttachmentMeta | null>>();
  const blobCache = new Map<string, Promise<AttachmentBlob | null>>();
  const objectUrls: string[] = [];
  let focused: string | null = null;
  let focusedSite: EmbedSite | undefined;

  /** One validated splice at an embed, or a notice saying it was left alone. */
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
      // The offline case and the deleted case look identical from here, and the chip says
      // "not available offline" in both — which is true in both.
      kernel.log.debug("attachment not available", { id, error });
      return null;
    }
  };

  const runtime: MarkdownRuntime & { dispose(): void } = {
    kernel,

    openDocument: (id, fragment) => {
      const base = router ? router.href(DOC_ROUTE, { id }) : `/doc/${encodeURIComponent(id)}`;
      const path = fragment ? `${base}#${fragment}` : base;
      if (router) router.navigate(path);
      // INTEGRATION (base-shell): with `router` absent — a failed activation, or a
      // workspace that replaced it — the hash is the documented fallback (`router`'s own
      // `navigate` sets `location.hash`), so a `doc://` link still works in a degraded
      // boot instead of doing nothing.
      else location.hash = path;
    },

    titleOf: async (id) => {
      const row = await kernel.documents.get(id);
      return row?.title;
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

    promote: async (attachmentId, options) => {
      const meta = await runtime.attachmentMeta(attachmentId);
      const title = meta?.name ?? attachmentId;
      const lines = ["---", `title: ${yamlScalar(title)}`];
      if (options?.path) lines.push(`path: ${yamlScalar(options.path)}`);
      lines.push("---", "", `![${title.replace(/[[\]]/g, "")}](attachment://${attachmentId})`, "");
      return kernel.documents.create({ text: lines.join("\n") });
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
          return;
        }
        // SPEC §3.3: a minimal text splice, one character wide, through the kernel helper
        // — never a re-serialize of the list, and never a whole-line replacement.
        kernel.documents.splice.apply(
          open,
          [{ range: { start: at, end: at + 1 }, text: next }],
          TASK_SPLICE_ORIGIN,
        );
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

/**
 * Quote a frontmatter scalar when it would otherwise change the line's meaning.
 *
 * A wrapper document is *machine-authored* (SPEC §3.3: "machine-owned documents … may be
 * wholly authored by their owning plugin"), so this writes the whole block rather than
 * splicing — but a filename containing `:` or `#` still has to survive the strict YAML
 * subset of SPEC §3.4, and a title of `2026-01-01` must not be typed as a date.
 */
function yamlScalar(value: string): string {
  // Leading indicator characters (a value opening with `"` or `'` would be read as a quoted
  // scalar and then be malformed), a `: ` or ` #` anywhere, leading/trailing whitespace, and
  // the plain forms that would be typed as bool/null/number rather than string.
  const control = /[\u0000-\u001f]/.test(value);
  const needsQuotes =
    control || /^["'\s>|@`%&*!{}[\],#?:-]|[:#]\s|\s$|^$|^(?:true|false|null|~|-?\d)/i.test(value);
  if (!needsQuotes) return value;
  // Control characters are escaped, never emitted raw: `options.path` comes from an
  // `fm.path` value any workspace user can write, and a raw newline inside a quoted
  // scalar is not a quoted scalar — it is an injected second frontmatter line
  // (`core::value::quote_double` is the rule both sides follow).
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
