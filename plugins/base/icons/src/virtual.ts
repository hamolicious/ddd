/**
 * Which rows of a virtual grid to draw: pure, so tested without a browser.
 *
 * The grid is `rows` rows of `rowHeight` pixels in a viewport `viewport` pixels tall,
 * scrolled to `scrollTop`. Only the rows in view are drawn, plus `overscan` either side so
 * a fast scroll does not show blank space before React catches up.
 */

export interface RowWindow {
  /** The first row to draw. */
  readonly first: number;
  /** One past the last row to draw. */
  readonly end: number;
}

export function rowWindow(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  rows: number,
  overscan = 3,
): RowWindow {
  if (rows <= 0 || rowHeight <= 0) return { first: 0, end: 0 };
  const top = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const bottom = Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewport)) / rowHeight) + overscan;
  return { first: Math.min(top, rows), end: Math.min(Math.max(bottom, top), rows) };
}

/** How many cells of at least `cell` pixels fit across `width`; always at least one. */
export function columnsFor(width: number, cell: number): number {
  return Math.max(1, Math.floor(width / cell));
}
