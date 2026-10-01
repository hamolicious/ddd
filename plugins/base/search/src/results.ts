/**
 * Resolving a search: **one query plan** — text, filter, folder relations and sort — that
 * the kernel's query engine answers live (`documents.subscribePlan`), the same engine the
 * server runs. A result obeys the filter, hides machine documents and updates as the feed
 * arrives, exactly as the plain list does, and ranking, "best match", paging and snippets
 * all come from that one answer.
 *
 * Two filters, and the difference matters. What the *user* asked for decides which empty
 * state to show; what the query runs also hides machine-owned documents unless the search
 * asks for them (`_shared/machine-docs.ts`). "Is inside note" is the engine's own
 * `child_of` join, so nothing here watches the folder tree.
 *
 * **Paged.** A page is `pageSize` rows (the view decides: the table's is its height); the
 * next loads when `more` is called.
 *
 * **Other providers.** A plugin may add a search source (`addProvider`: a semantic index,
 * an external wiki). Their hits are what the engine did not find; they follow its
 * results, filtered by the same filter, and a provider that fails marks the answer
 * `partial` rather than blanking it.
 *
 * **Changing the search keeps the last answer on screen until the new one is in.** A new
 * text has no answer for a moment; handing that over would swap the view for an empty
 * state and back, shifting everything under it. While `loading`, the rows, total and
 * `hasMore` are the last settled ones instead.
 */

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

/** How long the text waits for the next keystroke before it is searched. */
const TEXT_DEBOUNCE_MS = 140;

/** Folder relations go to the engine as its own `child_of` node. */
const NATIVE: ConditionContext = { native: true };

/** What `useResults` knows beyond the protocol's answer, for the page around a view. */
export interface PageResults extends SearchResults {
  /** The user's own filter is empty: "no documents yet" rather than "nothing matches". */
  readonly unfiltered: boolean;
}

/** The search's own filter, and every `within` condition besides. */
function narrowed(effective: FilterJson | undefined, within: readonly SearchClause[] | undefined): FilterJson | undefined {
  const extra =
    within && within.length > 0
      ? buildConditions({ combine: "and", clauses: within as readonly FilterClause[] }, NATIVE)
      : undefined;
  if (extra === undefined) return effective;
  return effective === undefined ? extra : { and: [effective, extra] };
}

/** The sort keys a search's sort means. "Best match" breaks its ties by last updated. */
export function sortTokens(sort: SearchSort): readonly string[] {
  if (sort.field === RELEVANCE.field) return ["relevance", "-updated_at"];
  return [sort.direction === "desc" ? `-${sort.field}` : sort.field];
}

/** The plan a search means, for `limit` rows. */
export function planFor(text: string, filter: FilterJson | undefined, sort: SearchSort, limit: number): QueryPlan {
  return {
    ...(text !== "" ? { text, snippets: true } : {}),
    ...(filter !== undefined ? { filter } : {}),
    sort: sortTokens(sort),
    limit,
  };
}

/** "Best match" ascending is the ranking read from the bottom: the page, reversed. */
function ordered<T>(rows: readonly T[], sort: SearchSort, searching: boolean): readonly T[] {
  return searching && sort.field === RELEVANCE.field && sort.direction === "asc" ? [...rows].reverse() : rows;
}

/** `value`, once it has stopped changing for `ms`. */
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

  // Other providers: what they find that the engine did not, under the same filter.
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
  // `total` stays absent while there is text, as `SearchResults` promises: the view says
  // "N results for …" then, and "N documents" for the plain list.
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

/**
 * The search's rows once, outside React: the same plan as {@link useResults}, answered
 * once. Other providers are not asked: this is for a caller that wants the workspace's
 * answer (a command over a saved search's documents).
 */
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

/** Every loaded row's id, reported whenever they change. */
export function useReportRendered(rows: readonly DocumentRow[], report?: (ids: readonly string[]) => void): void {
  const [last, setLast] = useState("");
  const rendered = rows.map((row) => row.id).join(",");
  useEffect(() => {
    if (rendered === last) return;
    setLast(rendered);
    report?.(rendered === "" ? [] : rendered.split(","));
  }, [rendered, last, report]);
}
