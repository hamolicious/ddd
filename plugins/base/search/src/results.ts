import { useEffect, useMemo, useRef, useState } from "react";

import type { DocumentRow, DocumentsApi, FilterJson, QueryPlan } from "@kernel";
import type { SearchClause, SearchResults, SearchSort, SearchSpec } from "./api.js";

import { buildConditions, type ConditionContext, type FilterClause } from "../../_shared/conditions.js";
import { limitFor, usePages } from "../../_shared/pagination.js";
import { useLivePlan } from "../../_shared/useLiveQuery.js";

import { RELEVANCE, buildEffectiveFilter, buildFilter } from "./filter.js";
import { effectiveSort, filterOf } from "./spec.js";
import { useSearch, type SearchEngine } from "./useSearch.js";

export const DEFAULT_PAGE_SIZE = 50;

const TEXT_DEBOUNCE_MS = 140;

const NATIVE: ConditionContext = { native: true };

export interface PageResults extends SearchResults {
  readonly unfiltered: boolean;
}

function narrowed(effective: FilterJson | undefined, within: readonly SearchClause[] | undefined): FilterJson | undefined {
  const extra =
    within && within.length > 0
      ? buildConditions({ combine: "and", clauses: within as readonly FilterClause[] }, NATIVE)
      : undefined;
  if (extra === undefined) return effective;
  return effective === undefined ? extra : { and: [effective, extra] };
}

export function sortTokens(sort: SearchSort): readonly string[] {
  if (sort.field === RELEVANCE.field) return ["relevance", "-updated_at"];
  return [sort.direction === "desc" ? `-${sort.field}` : sort.field];
}

export function planFor(text: string, filter: FilterJson | undefined, sort: SearchSort, limit: number): QueryPlan {
  return {
    ...(text !== "" ? { text, snippets: true } : {}),
    ...(filter !== undefined ? { filter } : {}),
    sort: sortTokens(sort),
    limit,
  };
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
  documents: DocumentsApi,
  engine: SearchEngine,
  spec: SearchSpec,
  options: { readonly pageSize?: number; readonly within?: readonly SearchClause[] } = {},
): PageResults {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));
  const draft = filterOf(spec);
  const typed = spec.query.trim();
  const text = useDebounced(typed, TEXT_DEBOUNCE_MS);
  const searching = text !== "";
  const sort = effectiveSort({ ...spec, query: text });

  const userFilter = buildFilter(draft, NATIVE);
  const effective = narrowed(buildEffectiveFilter(draft, NATIVE), options.within);
  const [pages, more] = usePages(JSON.stringify([effective, sort, text, pageSize]));
  const limit = limitFor(pages, pageSize);

  const live = useLivePlan(documents, planFor(text, effective, sort, limit));

  const found = useSearch(engine, text, { limit, debounceMs: 0 });
  const extraIds = useMemo(() => {
    const seen = new Set(live.rows.map((row) => row.id));
    return found.hits.map((hit) => hit.id).filter((id) => !seen.has(id));
  }, [found.hits, live.rows]);
  const extra = useLivePlan(
    documents,
    extraIds.length === 0
      ? undefined
      : {
          filter: {
            and: [
              { in: { field: "id", values: extraIds.map((id) => ({ str: id })) } },
              ...(effective !== undefined ? [effective] : []),
            ],
          },
          limit: extraIds.length,
        },
  );

  const rows = useMemo(() => {
    const rank = new Map(extraIds.map((id, index) => [id, index]));
    const extras = [...extra.rows].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    return ordered([...live.rows, ...extras], sort, searching);
  }, [live.rows, extra.rows, extraIds, sort, searching]);

  const loading = live.loading || extra.loading || typed !== text || (searching && found.running);
  const now = {
    rows,
    total: searching ? undefined : live.total + extra.rows.length,
    hasMore: live.rows.length < live.total,
  };
  const settled = useRef<typeof now | undefined>(undefined);
  if (!loading) settled.current = now;
  const shown = loading && settled.current ? settled.current : now;
  const hits = live.hits;

  return {
    rows: shown.rows,
    ...(shown.total !== undefined ? { total: shown.total } : {}),
    hasMore: shown.hasMore,
    loading,
    partial: searching && found.results.some((result) => result.error !== undefined),
    ...(live.error !== undefined ? { error: live.error } : {}),
    more,
    snippetOf: (row) => (searching ? hits[row.id]?.snippet : undefined),
    unfiltered: userFilter === undefined,
  };
}

export async function resolveSearch(
  documents: DocumentsApi,
  spec: SearchSpec,
  options: { readonly limit?: number; readonly within?: readonly SearchClause[] } = {},
): Promise<readonly DocumentRow[]> {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_SIZE));
  const text = spec.query.trim();
  const sort = effectiveSort(spec);
  const effective = narrowed(buildEffectiveFilter(filterOf(spec), NATIVE), options.within);
  const result = await documents.queryPlan(planFor(text, effective, sort, limit));
  return ordered(result.rows, sort, text !== "");
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
