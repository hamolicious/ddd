import { useEffect, useMemo, useRef, useState } from "react";

import type { AnySearchBuilder, DocumentRow, SearchApi } from "@kernel";
import type { SearchClause, SearchResults, SearchSnippet, SearchSort, SearchSpec } from "./api.js";

import { hasConditions, whereConditions, type FilterClause } from "../../_shared/conditions.js";
import { notMachine, useLiveSearch, type Watchable } from "../../_shared/live-search.js";
import { matchSnippet } from "../../_shared/match.js";
import { limitFor, usePages } from "../../_shared/pagination.js";

import { RELEVANCE, filterCondition, hasFilter, type FilterDraft } from "./filter.js";
import { effectiveSort, filterOf } from "./spec.js";
import { useSearch, type SearchEngine } from "./useSearch.js";

export const DEFAULT_PAGE_SIZE = 50;

const TEXT_DEBOUNCE_MS = 140;

export interface PageResults extends SearchResults {
  readonly unfiltered: boolean;
}

export interface QueryOptions {
  readonly within?: readonly SearchClause[];
  readonly withContent?: boolean;
  readonly fuzzy?: string;
  readonly fuzzySort?: SearchSort;
}

export function sortTokens(sort: SearchSort, searching = true): readonly string[] {
  if (sort.field === RELEVANCE.field) return searching ? ["relevance", "-updated_at"] : ["-updated_at"];
  return [sort.direction === "desc" ? `-${sort.field}` : sort.field];
}

type Row = DocumentRow & { readonly snippet?: SearchSnippet | null; readonly content?: string };

export function searchQuery(
  search: SearchApi,
  text: string,
  draft: FilterDraft,
  sort: SearchSort,
  options: QueryOptions = {},
): AnySearchBuilder {
  const fuzzy = options.fuzzy?.trim() ?? "";
  let query = search.fromAny();
  if (text !== "") query = query.text(text);
  if (hasFilter(draft)) query = query.where((w) => filterCondition(w, draft) ?? w.and());
  if (draft.includeMachine !== true) query = query.where(notMachine);
  const within: FilterDraft = { combine: "and", clauses: (options.within ?? []) as readonly FilterClause[] };
  if (hasConditions(within)) query = query.where((w) => whereConditions(w, within) ?? w.and());
  if (fuzzy !== "") {
    const ranked = query.fuzzy(fuzzy);
    const sorted = options.fuzzySort ? ranked.sort(...sortTokens(options.fuzzySort, text !== "")) : ranked;
    return sorted.withContent().withTotal();
  }
  query = query.sort(...sortTokens(sort, text !== ""));
  const withText = text !== "" ? query.snippets() : query;
  return options.withContent === true ? withText.withContent() : withText;
}

function ordered<T>(rows: readonly T[], sort: SearchSort, searching: boolean): readonly T[] {
  return searching && sort.field === RELEVANCE.field && sort.direction === "asc" ? [...rows].reverse() : rows;
}

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export function useResults(
  search: SearchApi,
  engine: SearchEngine,
  spec: SearchSpec,
  options: { readonly pageSize?: number; readonly within?: readonly SearchClause[]; readonly withContent?: boolean } = {},
): PageResults {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));
  const draft = filterOf(spec);
  const typed = spec.query.trim();
  const text = useDebounced(typed, TEXT_DEBOUNCE_MS);
  const fuzzyTyped = (spec.fuzzy ?? "").trim();
  const fuzzyText = useDebounced(fuzzyTyped, TEXT_DEBOUNCE_MS);
  const fuzzy = fuzzyText !== "";
  const searching = text !== "" || fuzzy;
  const sort = effectiveSort({ ...spec, query: text });

  const query = searchQuery(search, text, draft, sort, {
    ...options,
    ...(fuzzy ? { fuzzy: fuzzyText } : {}),
    ...(fuzzy && spec.sort ? { fuzzySort: spec.sort } : {}),
  });
  const [pages, more] = usePages(JSON.stringify(query.plan()) + pageSize);
  const limit = limitFor(pages, pageSize);
  const live = useLiveSearch(query as unknown as Watchable<Row>, { start: 0, count: limit });

  const found = useSearch(engine, fuzzy ? "" : text, { limit, debounceMs: 0 });
  const extraIds = useMemo(() => {
    const seen = new Set(live.rows.map((row) => row.id));
    return found.hits.map((hit) => hit.id).filter((id) => !seen.has(id));
  }, [found.hits, live.rows]);
  const extraQuery =
    extraIds.length === 0 ? undefined : searchQuery(search, "", draft, sort, options).where("id", "in", extraIds);
  const extra = useLiveSearch(extraQuery as unknown as Watchable<Row> | undefined);

  const rows = useMemo(() => {
    const rank = new Map(extraIds.map((id, index) => [id, index]));
    const extras = [...extra.rows].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    return ordered([...live.rows, ...extras], sort, text !== "" && !fuzzy);
  }, [live.rows, extra.rows, extraIds, sort, text, fuzzy]);

  const loading = live.loading || extra.loading || typed !== text || fuzzyTyped !== fuzzyText || (searching && found.running);
  const now = {
    rows,
    total: searching ? undefined : live.total + extra.rows.length,
    hasMore: live.rows.length < live.total,
  };
  const settled = useRef<typeof now | undefined>(undefined);
  if (!loading) settled.current = now;
  const shown = loading && settled.current ? settled.current : now;

  return {
    rows: shown.rows,
    ...(shown.total !== undefined ? { total: shown.total } : {}),
    hasMore: shown.hasMore,
    loading,
    partial: searching && found.results.some((result) => result.error !== undefined),
    ...(live.error !== undefined ? { error: live.error } : {}),
    more,
    snippetOf: (row) => {
      if (!fuzzy) return text !== "" ? ((row as Row).snippet ?? undefined) : undefined;
      const terms = live.hits[row.id]?.terms;
      const content = (row as Row).content;
      return terms && content !== undefined ? matchSnippet(content, terms) : undefined;
    },
    unfiltered: !hasFilter(draft),
  };
}

export async function resolveSearch(
  search: SearchApi,
  spec: SearchSpec,
  options: { readonly limit?: number; readonly within?: readonly SearchClause[] } = {},
): Promise<readonly DocumentRow[]> {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_SIZE));
  const text = spec.query.trim();
  const sort = effectiveSort(spec);
  const fuzzy = (spec.fuzzy ?? "").trim();
  const result = await searchQuery(search, text, filterOf(spec), sort, {
    ...options,
    ...(fuzzy !== "" ? { fuzzy } : {}),
    ...(fuzzy !== "" && spec.sort ? { fuzzySort: spec.sort } : {}),
  })
    .limit(limit)
    .run();
  return ordered(result.rows as unknown as readonly DocumentRow[], sort, text !== "" && fuzzy === "");
}

export function useReportRendered(rows: readonly DocumentRow[], report?: (ids: readonly string[]) => void): void {
  const [last, setLast] = useState("");
  const rendered = rows.map((row) => row.id).join(",");
  useEffect(() => {
    if (rendered === last) return;
    setLast(rendered);
    report?.(rendered === "" ? [] : rendered.split(","));
  }, [rendered, last, report]);
}
