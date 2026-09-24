/**
 * Recognising an **attachment wrapper document** (SPEC §3.6), and deciding how to
 * preview a blob. Pure functions, unit-tested, no DOM.
 *
 * A wrapper is not a special object type: it is an ordinary markdown document whose
 * body embeds exactly one `attachment://<id>` and says nothing else. That is the whole
 * definition, and keeping it here — rather than as a flag in `fm` or a `%%%` section —
 * is what lets folders, search, tags, Trash, `doc://` links and the properties panel
 * apply to files with no special-case machinery. Rendering one as a file preview is a
 * *presentation* decision, which is why it lives in `viewer`.
 *
 * Deliberately conservative: a document that embeds one image **and** has prose around
 * it is a normal document that happens to contain a picture, and must render as prose.
 * Being wrong in that direction hides the user's writing behind a file chrome.
 */

/** A ULID is 26 Crockford base-32 characters; ids in links are matched loosely. */
const ID = "[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{4,64}";

/** `![alt](attachment://id)` or `[label](attachment://id)`, with optional title. */
const LONE_EMBED = new RegExp(
  `^(!?)\\[([^\\]]*)\\]\\(\\s*attachment://(${ID})\\s*(?:"[^"]*"|'[^']*')?\\s*\\)$`,
);

/** A bare `attachment://id`, or one in angle brackets. */
const LONE_URL = new RegExp(`^<?\\s*attachment://(${ID})\\s*>?$`);

export interface AttachmentReference {
  readonly id: string;
  /** The link text / alt text, when the body gave one. */
  readonly label?: string;
  /** `true` when the reference was written as an image embed (`![…](…)`). */
  readonly embedded: boolean;
}

/**
 * The single attachment a wrapper document wraps, or `undefined` when this body is not
 * a wrapper.
 *
 * Accepted shapes, after trimming blank lines: one embed on its own line, optionally
 * preceded by a single ATX heading (the title the upload wrote). Anything else — two
 * embeds, a paragraph, a list, a task — is a normal document.
 */
export function wrapperAttachmentOf(body: string): AttachmentReference | undefined {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  // A single leading heading is part of the wrapper, not content.
  const candidates = lines.length > 1 && /^#{1,6}\s/.test(lines[0] ?? "") ? lines.slice(1) : lines;
  if (candidates.length !== 1) return undefined;

  const only = candidates[0] ?? "";
  const link = LONE_EMBED.exec(only);
  if (link) {
    const [, bang, label, id] = link;
    return { id: id ?? "", label: label && label.length > 0 ? label : undefined, embedded: bang === "!" };
  }
  const bare = LONE_URL.exec(only);
  if (bare) return { id: bare[1] ?? "", embedded: false };
  return undefined;
}

/** Every `attachment://` id referenced by a body, in order, de-duplicated. */
export function attachmentIdsIn(body: string): readonly string[] {
  const found = new Set<string>();
  const pattern = new RegExp(`attachment://(${ID})`, "g");
  for (const match of body.matchAll(pattern)) {
    const id = match[1];
    if (id) found.add(id);
  }
  return [...found];
}

export type PreviewKind = "image" | "audio" | "video" | "pdf" | "text" | "file";

/**
 * How to preview a MIME type.
 *
 * **`image/svg+xml` is never previewed inline** (SPEC §3.6: stored-XSS vector). It
 * falls through to `"file"`, which renders a chip with a download action — the server
 * serves it `Content-Disposition: attachment` for the same reason, so an inline
 * `<img>` would be a broken image at best.
 */
export function previewKindFor(mime: string | undefined): PreviewKind {
  const type = (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/svg+xml") return "file";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return "file";
}

/** `1.2 MB` — for the chip under a file preview. Binary units, one decimal. */
export function formatBytes(size: number | undefined): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return "unknown size";
  if (size < 1024) return `${size} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
