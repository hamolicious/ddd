/**
 * The link/image URL allowlist — this plugin's security boundary (SPEC §8).
 *
 * > CSP: … Markdown: no raw-HTML passthrough in v1; link/image schemes allowlisted
 * > (`http`, `https`, `mailto`, `attachment`, `doc`).
 *
 * **An allowlist, not a blocklist.** A blocklist of `javascript:`/`data:`/`vbscript:`
 * loses to the next spelling someone finds; a five-entry allowlist has nothing to
 * enumerate. Anything not on it renders as literal text — never as an `<a href>`, never
 * as an `<img src>` — so a hostile document is unreadable-as-a-link rather than armed.
 *
 * Three concrete attacks this closes, all of which a naive `startsWith("javascript:")`
 * check lets through:
 *
 * - **Character references.** `&#106;avascript:alert(1)` — remark decodes these while
 *   parsing, so the check below sees the decoded form. That is why classification
 *   happens on the mdast `url`, after remark, and never on the raw source.
 * - **Embedded control characters.** `java<LF>script:alert(1)` and `java<TAB>script:` —
 *   browsers strip C0 controls and tabs from URLs before resolving the scheme, so they
 *   are stripped here before matching too.
 * - **Case and leading whitespace.** ` JaVaScRiPt:` — whitespace removed, lowercased.
 *
 * Percent-encoding needs no special case: `%6aavascript:` is not a syntactically valid
 * scheme (`%` is not a scheme character), so it fails the scheme match and is blocked,
 * and no browser resolves it as one either.
 *
 * **Scheme-relative and relative URLs are blocked.** `//evil.example/x` inherits the
 * page's scheme and `./notes.md` means nothing in an app where documents are
 * id-addressed (`doc://<ulid>`) — so neither is allowed through. The one exception is a
 * pure `#fragment`, which is an in-page anchor and cannot leave the document.
 */

/** The five schemes SPEC §8 allows in a rendered document. */
export const ALLOWED_SCHEMES: readonly string[] = ["http", "https", "mailto", "attachment", "doc"];

export type UrlVerdict =
  /** An allowlisted scheme. `rest` is everything after `<scheme>:`, `//` included. */
  | {
      readonly kind: "allowed";
      readonly scheme: string;
      readonly url: string;
      readonly rest: string;
    }
  /** A pure in-page anchor (`#heading`). No scheme, cannot navigate away. */
  | { readonly kind: "fragment"; readonly url: string }
  /** Render as literal text. `reason` is for the log, never for the DOM. */
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * C0 controls, space and DEL — what a browser strips from a URL before parsing it.
 * Written with escapes on purpose: a literal control character in a source file is
 * invisible in every diff it ever appears in.
 */
const STRIPPED = /[\u0000-\u0020\u007f]/g;

/** `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )` (RFC 3986), anchored. */
const SCHEME = /^([A-Za-z][A-Za-z0-9+.\-]*):/;

/**
 * Classify a link or image destination. Total: every string gets a verdict, and the
 * default is `blocked`.
 *
 * Whitespace is removed rather than only trimmed, because a URL may not contain raw
 * whitespace at all — a browser strips it, so leaving it in would let the two disagree
 * about where the scheme ends, which is the whole game.
 */
export function classifyUrl(raw: string | null | undefined): UrlVerdict {
  if (typeof raw !== "string") return { kind: "blocked", reason: "no destination" };
  const cleaned = raw.replace(STRIPPED, "");
  if (cleaned.length === 0) return { kind: "blocked", reason: "empty destination" };

  const match = SCHEME.exec(cleaned);
  if (!match) {
    if (cleaned.startsWith("#")) return { kind: "fragment", url: cleaned };
    return {
      kind: "blocked",
      reason: cleaned.startsWith("//") ? "scheme-relative URL" : "relative URL",
    };
  }

  const scheme = (match[1] ?? "").toLowerCase();
  if (!ALLOWED_SCHEMES.includes(scheme)) {
    return { kind: "blocked", reason: `scheme "${scheme}" is not allowlisted` };
  }
  return { kind: "allowed", scheme, url: cleaned, rest: cleaned.slice(match[0].length) };
}

/** `true` when a destination may be put in an `href`/`src`. */
export function isAllowed(raw: string | null | undefined): boolean {
  const verdict = classifyUrl(raw);
  return verdict.kind === "allowed" || verdict.kind === "fragment";
}

/**
 * The opaque id of a `doc://<ulid>` or `attachment://<ulid>` destination.
 *
 * Tolerant of both spellings — `doc://01J…` (SPEC §3.6's form) and `doc:01J…` — and
 * stops at the first `/`, `?` or `#` so a trailing fragment is not swallowed into the
 * id. Returns `null` for the wrong scheme or an empty id.
 *
 * The id is **not** validated against the ULID alphabet: the kernel is the authority on
 * what a document id is, an unknown id already renders as a broken-link chip, and a
 * stricter check here would only turn a chip that says "missing document" into a chip
 * that says nothing.
 */
export function idFromScheme(
  raw: string | null | undefined,
  scheme: "doc" | "attachment",
): string | null {
  const verdict = classifyUrl(raw);
  if (verdict.kind !== "allowed" || verdict.scheme !== scheme) return null;
  const rest = verdict.rest.startsWith("//") ? verdict.rest.slice(2) : verdict.rest;
  const id = rest.split(/[/?#]/, 1)[0] ?? "";
  return id.length > 0 ? id : null;
}

/** The `#fragment` of a destination, without the `#`; `null` when absent. */
export function fragmentOf(raw: string | null | undefined): string | null {
  const verdict = classifyUrl(raw);
  const url = verdict.kind === "blocked" ? "" : verdict.url;
  const hash = url.indexOf("#");
  if (hash < 0 || hash === url.length - 1) return null;
  return url.slice(hash + 1);
}
