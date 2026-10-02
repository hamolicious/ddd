import { useEffect, useState } from "react";

export const PAGE_SIZE = 50;

export function limitFor(pages: number, size: number = PAGE_SIZE): number {
  return Math.max(1, Math.floor(pages)) * Math.max(1, Math.floor(size));
}

export function remaining(shown: number, total: number): number {
  return Math.max(0, total - shown);
}

export function showingText(shown: number, total: number): string {
  const format = (n: number): string => n.toLocaleString();
  return shown >= total ? `${format(total)} document${total === 1 ? "" : "s"}` : `Showing ${format(shown)} of ${format(total)}`;
}

export function usePages(resetKey: string): readonly [number, () => void] {
  const [state, setState] = useState({ key: resetKey, pages: 1 });
  const pages = state.key === resetKey ? state.pages : 1;
  useEffect(() => {
    if (state.key !== resetKey) setState({ key: resetKey, pages: 1 });
  }, [resetKey, state.key]);
  const more = (): void => setState({ key: resetKey, pages: pages + 1 });
  return [pages, more] as const;
}
