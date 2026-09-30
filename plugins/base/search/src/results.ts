/**
 * Resolving a search: the providers find ids for the text (`useSearch.ts`), and a live
 * local query runs the filter and the sort over them — so a result obeys the filter, hides
 * machine documents, and updates as the feed arrives, exactly as the plain list does. With
 * no text, the query is the whole answer.
 *
 * Two filters, and the difference matters. What the *user* asked for decides which empty
 * state to show; what the query runs also hides machine-owned documents unless the search
 * asks for them (`_shared/machine-docs.ts`). "Is inside note" is built from that note's
 * children, watched live.
 *
 * **Paged.** A page is `pageSize` rows (the view decides: the table's is its height); the
 * next loads when `more` is called. With text, the providers are asked for as many hits as
 * the pages hold, so "more" exists while they fill what they were asked for — they report
 * pages, not totals, which is why `total` is absent then.
 *
 * **"Best match"** is not a field: the rows are put back in the providers' rank order
 * after the query, which sorts on `updated_at` so the page it returns is stable.
 *
 * **Changing the search keeps the last answer on screen until the new one is in.** A new
 * text has no hits for a moment, so its query briefly matches nothing; handing that over
 * would swap the view for an empty state and back, shifting everything under it. While
 * `loading`, the rows, total and `hasMore` are the last settled ones instead.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { DocumentQuery, DocumentRow, DocumentsApi, FilterJson } from "@kernel";
import type { SearchClause, SearchResults, SearchSpec } from "./api.js";

import { buildConditions, treeToWatch, CHILDREN_FIELD, type FilterClause } from "../../_shared/conditions.js";
import { childrenIn, contextFrom, useConditionContext } from "../../_shared/conditions-children.js";
import { limitFor, usePages } from "../../_shared/pagination.js";
import { useLiveQuery } from "../../_shared/useLiveQuery.js";

import { RELEVANCE, buildEffectiveFilter, buildFilter, buildSort } from "./filter.js";
import { mergeHits, snippetFor } from "./merge.js";
import { effectiveSort, filterOf } from "./spec.js";
import { useSearch, type SearchEngine } from "./useSearch.js";

export const DEFAULT_PAGE_SIZE = 50;

/** What `useResults` knows beyond the protocol's answer, for the page around a view. */
export interface PageResults extends SearchResults {
  /** The user's own filter is empty: "no documents yet" rather than "nothing matches". */
  readonly unfiltered: boolean;
}

/** The search's own filter, and every `within` condition besides. */
function narrowed(effective: FilterJson | undefined, within: readonly SearchClause[] | undefined): FilterJson | undefined {
  const extra =
    within && within.length > 0
      ? buildConditions({ combine: "and", clauses: within as readonly FilterClause[] })
      : undefined;
  if (extra === undefined) return effective;
  return effective === undefined ? extra : { and: [effective, extra] };
}

export function useResults(
  documents: DocumentsApi,
  engine: SearchEngine,
  spec: SearchSpec,
  options: { readonly pageSize?: number; readonly within?: readonly SearchClause[] } = {},
): PageResults {
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE));
  const draft = filterOf(spec);
  const text = spec.query.trim();
  const searching = text !== "";
  const sort = effectiveSort(spec);
  const byRank = sort.field === RELEVANCE.field;

  const context = useConditionContext(documents, treeToWatch(draft));
  const userFilter = buildFilter(draft, context);
  const effective = narrowed(buildEffectiveFilter(draft, context), options.within);
  const [pages, more] = usePages(JSON.stringify([effective, sort, text, pageSize]));
  const limit = limitFor(pages, pageSize);
  const found = useSearch(engine, text, { limit });
  const ids = found.hits.map((hit) => hit.id);

  const query = useMemo<DocumentQuery>(() => {
    const within: FilterJson = { in: { field: "id", values: ids.map((id) => ({ str: id })) } };
    const filter = searching ? (effective === undefined ? within : { and: [effective, within] }) : effective;
    return {
      ...(filter !== undefined ? { filter } : {}),
      sort: buildSort(byRank ? "updated_at" : sort.field, sort.direction),
      limit,
    };
  }, [JSON.stringify(effective), sort.field, sort.direction, limit, searching, ids.join(",")]);

  const live = useLiveQuery(documents, query);
  const rows = useMemo(() => {
    if (!searching || !byRank) return live.rows;
    const rank = new Map(ids.map((id, index) => [id, index]));
    const ranked = [...live.rows].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    return sort.direction === "desc" ? ranked : ranked.reverse();
  }, [live.rows, searching, byRank, sort.direction, ids.join(",")]);
  const terms = useMemo(() => new Map(found.hits.map((hit) => [hit.id, hit.terms])), [found.hits]);

  // The providers have not answered this text yet (typing, or the debounce).
  const pending = searching && (found.running || found.settled !== text);
  const hasMore = searching ? found.hits.length >= limit : live.rows.length < live.total;
  const loading = live.loading || pending;

  const now = { rows, total: searching ? undefined : live.total, hasMore };
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
    snippetOf: (row) => (searching ? snippetFor(row.content, terms.get(row.id) ?? []) : undefined),
    unfiltered: userFilter === undefined,
  };
}

/**
 * The search's rows once, outside React: the same rules as {@link useResults}, with the
 * folder tree read once instead of watched.
 */
export async function resolveSearch(
  documents: DocumentsApi,
  engine: SearchEngine,
  spec: SearchSpec,
  options: { readonly limit?: number; readonly within?: readonly SearchClause[] } = {},
): Promise<readonly DocumentRow[]> {
  const limit = Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_SIZE));
  const draft = filterOf(spec);
  const text = spec.query.trim();
  const sort = effectiveSort(spec);
  const byRank = sort.field === RELEVANCE.field;

  const watch = treeToWatch(draft);
  let children = new Map<string, readonly string[]>();
  if (watch.length > 0) {
    const filter: FilterJson =
      watch === "all"
        ? { exists: { field: CHILDREN_FIELD } }
        : { in: { field: "id", values: watch.map((id) => ({ str: id })) } };
    const tree = await documents.query({ filter });
    children = new Map(tree.rows.map((row) => [row.id, childrenIn(row.plugins)]));
  }
  const effective = narrowed(buildEffectiveFilter(draft, contextFrom(children)), options.within);

  let ids: readonly string[] | undefined;
  if (text !== "") {
    ids = mergeHits(await engine.run(text, { limit }), limit).map((hit) => hit.id);
    if (ids.length === 0) return [];
  }
  const within: FilterJson | undefined =
    ids === undefined ? undefined : { in: { field: "id", values: ids.map((id) => ({ str: id })) } };
  const filter = within === undefined ? effective : effective === undefined ? within : { and: [effective, within] };
  const result = await documents.query({
    ...(filter !== undefined ? { filter } : {}),
    sort: buildSort(byRank ? "updated_at" : sort.field, sort.direction),
    limit,
  });
  if (ids === undefined || !byRank) return result.rows;
  const rank = new Map(ids.map((id, index) => [id, index]));
  const ranked = [...result.rows].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return sort.direction === "desc" ? ranked : ranked.reverse();
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
