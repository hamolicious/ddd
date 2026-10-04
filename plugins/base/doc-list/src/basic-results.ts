import { useEffect, useRef, useState } from "react";

import type { DocumentRow, SearchApi } from "@kernel";
import type { SearchResults } from "plugin:search";

import { notMachine, useLiveSearch, type Watchable } from "../../_shared/live-search.js";
import { limitFor, usePages } from "../../_shared/pagination.js";

import { matchSnippet } from "./match.js";

export const BASIC_PAGE_SIZE = 50;

const TYPING_DEBOUNCE_MS = 140;

type Row = DocumentRow & { readonly content?: string };

export function basicQuery(search: SearchApi, text: string): Watchable<Row> {
  const query = search.fromAny().where(notMachine).withTotal();
  return (text === "" ? query.sort("-updated_at") : query.withContent().fuzzy(text)) as unknown as Watchable<Row>;
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function useBasicResults(search: SearchApi, query: string): SearchResults {
  const typed = query.trim();
  const text = useDebounced(typed, TYPING_DEBOUNCE_MS);
  const watched = basicQuery(search, text);
  const [pages, more] = usePages(JSON.stringify(watched.plan()));
  const live = useLiveSearch(watched, { start: 0, count: limitFor(pages, BASIC_PAGE_SIZE) });
  const loading = live.loading || typed !== text;
  const now = { rows: live.rows, total: live.total, hits: live.hits };
  const settled = useRef<typeof now | undefined>(undefined);
  if (!loading) settled.current = now;
  const shown = loading && settled.current ? settled.current : now;
  return {
    rows: shown.rows,
    total: shown.total,
    hasMore: shown.rows.length < shown.total,
    loading,
    partial: false,
    ...(live.error !== undefined ? { error: live.error } : {}),
    more,
    snippetOf: (row) => {
      const terms = shown.hits[row.id]?.terms;
      const content = (row as Row).content;
      return terms && content !== undefined ? matchSnippet(content, terms) : undefined;
    },
  };
}
