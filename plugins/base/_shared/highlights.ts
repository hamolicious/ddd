/**
 * A search snippet's highlighted terms, split out for rendering: shared by `search` and the
 * views that show a result's matched line (the `table`).
 */

export interface HighlightedText {
  readonly text: string;
  /** Offsets into `text` to highlight, ascending and not overlapping. */
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
}

/** Split `text` into alternating plain/highlighted pieces, for rendering. */
export function splitHighlights<T extends HighlightedText>(
  snippet: T,
): readonly { readonly text: string; readonly hit: boolean }[] {
  const pieces: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const range of snippet.ranges) {
    if (range.start > cursor) pieces.push({ text: snippet.text.slice(cursor, range.start), hit: false });
    pieces.push({ text: snippet.text.slice(range.start, range.end), hit: true });
    cursor = range.end;
  }
  if (cursor < snippet.text.length) pieces.push({ text: snippet.text.slice(cursor), hit: false });
  return pieces;
}
