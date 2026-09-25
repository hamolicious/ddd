/**
 * `?line=N` — the deep-link query the document route understands.
 *
 * ## Why the surface owns it
 *
 * The number is parsed once, here, and handed to the active mode as
 * `DocumentModeProps.line`. Two reasons it is not each mode's own job:
 *
 * - the surface is what knows when the document actually *arrived*; a mode reading
 *   `location.hash` on mount would aim at a document that has not hydrated;
 * - a mode would have to re-read the URL to notice a **query-only** navigation, and
 *   following a second search result into the document already on screen is exactly
 *   that. `router.onChange` reports it (`fullPath` keeps the query on purpose).
 *
 * ## What it means
 *
 * A **1-based line of the materialized text** — frontmatter and `%%%` sections
 * included, because that is the string the editor holds, so the number means the same
 * thing to whoever produced the link (`search`) and whoever consumes it (`editor`).
 *
 * Honouring it is best effort and a mode's own business: `editor` moves the cursor and
 * scrolls, a rendered mode has no lines to scroll to and may ignore it. A line past the
 * end is clamped by the mode, never an error here.
 *
 * It is a deep link, not state: every mode must render correctly without it.
 */

/** The query parameter's name. `search` spells the same string in its own `hash.ts`. */
export const LINE_PARAM = "line";

/**
 * The line a path asks for, or `undefined`.
 *
 * Anything that is not a positive integer is **no line at all**, not line 1: `?line=abc`
 * or `?line=0` from a hand-edited address bar should leave the document where it opened
 * rather than silently scroll somewhere.
 */
export function lineFromPath(path: string): number | undefined {
  const at = path.indexOf("?");
  if (at < 0) return undefined;
  const raw = new URLSearchParams(path.slice(at + 1)).get(LINE_PARAM);
  if (raw === null || !/^\d+$/.test(raw)) return undefined;
  const line = Number(raw);
  return Number.isSafeInteger(line) && line >= 1 ? line : undefined;
}
