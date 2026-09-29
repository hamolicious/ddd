/**
 * Paging the list: a page at a time, never the whole workspace.
 *
 * **Pages grow the limit; they do not move a window.** The list is a live query, and a
 * live query over `offset` would shift under the reader every time a document was added
 * above the fold — a row read on page 2 turns up again on page 3. Asking for the first
 * `pages × PAGE_SIZE` rows keeps the subscription one query whose rows are exactly what
 * is on screen, so a change anywhere in them updates in place.
 *
 * **What this does and does not bound.** It bounds what the list renders and what a
 * live re-run hands over, which was the cost that grew with the workspace in *this*
 * plugin (the list used to stop at 200 and say so). The local engine still scans the
 * projection store to filter and sort; that is the kernel's to index, not this list's
 * to work around (POLISH-BACKLOG.md).
 */

import { useEffect, useState } from "react";

export const PAGE_SIZE = 50;

/** The query `limit` for this many pages. */
export function limitFor(pages: number): number {
  return Math.max(1, Math.floor(pages)) * PAGE_SIZE;
}

/** Rows not yet shown, if any. */
export function remaining(shown: number, total: number): number {
  return Math.max(0, total - shown);
}

/** "Showing 50 of 1,234": the total is always the real one, never a page's. */
export function showingText(shown: number, total: number): string {
  const format = (n: number): string => n.toLocaleString();
  return shown >= total ? `${format(total)} document${total === 1 ? "" : "s"}` : `Showing ${format(shown)} of ${format(total)}`;
}

/** The page count, back to one whenever `resetKey` (the query without its limit) changes. */
export function usePages(resetKey: string): readonly [number, () => void] {
  const [state, setState] = useState({ key: resetKey, pages: 1 });
  const pages = state.key === resetKey ? state.pages : 1;
  useEffect(() => {
    if (state.key !== resetKey) setState({ key: resetKey, pages: 1 });
  }, [resetKey, state.key]);
  const more = (): void => setState({ key: resetKey, pages: pages + 1 });
  return [pages, more] as const;
}
