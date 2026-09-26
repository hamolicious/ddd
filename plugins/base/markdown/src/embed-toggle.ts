/**
 * Writes to one embedded attachment's source: preview ⇄ link, and swapping it for a
 * link to the document it was promoted to.
 *
 * `![name](attachment://…)` and `[name](attachment://…)` differ by one `!`, so the
 * toggle is a one-character splice.
 *
 * The position comes from the render, and the render can be stale: the text may have
 * moved on since. So the embed's own source is checked at that position first, and when
 * it is not there, looked for once in the whole text. Found exactly once, that is the
 * one; found nowhere or twice over, nothing is written. Same rule as the task checkbox:
 * never write somewhere the reader did not click.
 */

export interface EmbedLocation {
  /** The embed's offset in the rendered text. */
  readonly at: number;
  /** The embed's source exactly as rendered, `!` included when it is a preview. */
  readonly source: string;
}

export interface TextEdit {
  readonly range: { readonly start: number; readonly end: number };
  readonly text: string;
}

/** Where the embed starts in `text` now, or `null` when it cannot be found unambiguously. */
export function locateEmbed(text: string, base: number, location: EmbedLocation): number | null {
  const { source } = location;
  if (source.length === 0) return null;
  const start = base + location.at;
  if (text.slice(start, start + source.length) === source) return start;
  const first = text.indexOf(source);
  if (first < 0 || text.indexOf(source, first + 1) >= 0) return null;
  return first;
}

/** The splice that flips this embed, or `null` when it cannot be found unambiguously. */
export function embedToggle(text: string, base: number, location: EmbedLocation): TextEdit | null {
  const start = locateEmbed(text, base, location);
  if (start === null) return null;
  return location.source.startsWith("!")
    ? { range: { start, end: start + 1 }, text: "" }
    : { range: { start, end: start }, text: "!" };
}

/** The splice that swaps this embed for `replacement`, under the same rule. */
export function embedReplace(
  text: string,
  base: number,
  location: EmbedLocation,
  replacement: string,
): TextEdit | null {
  const start = locateEmbed(text, base, location);
  if (start === null) return null;
  return { range: { start, end: start + location.source.length }, text: replacement };
}
