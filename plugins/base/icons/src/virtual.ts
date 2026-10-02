export interface RowWindow {
  readonly first: number;
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

export function columnsFor(width: number, cell: number): number {
  return Math.max(1, Math.floor(width / cell));
}
