/**
 * The main document list, and the Trash view, which are the same list with two rules
 * changed.
 *
 * **Trash is `includeDeleted` plus a filter, not another store** (SPEC §3.5): a
 * tombstoned document is an ordinary projection row with `deleted: true`, restorable for
 * 30 days, and purge is the server's job.
 *
 * **Trash sorts on `deleted_at`, in the engine.** It used to sort in this component
 * after the query, because the shared field space did not reach that root: the order
 * was then only correct over the page the query happened to return, and a workspace
 * with more tombstones than one page showed the wrong ones in a confident order.
 * `deleted_at` is a fixed root of the DSL now (`core::filter::ast::FIXED_ROOTS`), the
 * server compiles it, and `kernel/src/query/filter.ts` mirrors it — so the sort key is
 * just a sort key, and the direction toggle is one query parameter.
 *
 * **Search is this list, ranked.** The search bar runs the providers (`search/`) and the
 * list's own live query then runs over the ids they found — so a result obeys the
 * filters, hides machine documents, and updates live exactly as the plain list does.
 * The sort switches to "Best match" when a search starts and back when it is cleared;
 * any other sort still applies to the results. A result found only by the server, on a
 * client that has not synced it yet, is not shown: the list is what this device holds.
 * Each result carries the line that matched, and opening it opens at that line.
 *
 * **Results can be acted on together.** While a search or a filter narrows the list,
 * the toolbar's Actions button hands every loaded row's id to `onActions` — never the
 * whole unfiltered workspace, which is one careless tap from "trash everything".
 *
 * **Both are paged** (`pagination.ts`): a page of rows, and the next one loads by itself
 * as the end scrolls near — no button, no "Loading…" at the bottom. The count under the list is always the real total.
 * The document list is also virtual (`_shared/virtual-list.ts`): however many pages are
 * loaded, only the rows on screen are in the DOM.
 * "Loading…" replaces the list only while it has nothing to show; a page on its way
 * keeps the rows already there.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";

import type { DocumentQuery, DocumentRow, DocumentsApi, FilterJson } from "@kernel";
import type { ContextMenu } from "@protocols/lm/context-menu";

import { useVirtualList } from "../../_shared/virtual-list.js";
import { treeToWatch } from "../../_shared/conditions.js";
import { useConditionContext } from "../../_shared/conditions-children.js";
import { indexNoteSource, indexSuggestions, type ConditionIndex } from "../../_shared/conditions-index.js";
import { documentsNoteSource } from "../../_shared/note-picker.js";

import { FilterBar } from "./FilterBar.js";
import {
  RELEVANCE,
  TRASHED_ONLY,
  buildEffectiveFilter,
  buildFilter,
  buildSort,
  type FilterDraft,
} from "./filter.js";
import { LoadMore } from "./LoadMore.js";
import { limitFor, showingText, usePages } from "./pagination.js";
import { snippetFor, splitHighlights, type Snippet } from "./search/merge.js";
import { useSearch, type SearchEngine } from "./search/useSearch.js";
import { useLiveQuery } from "./useLiveQuery.js";

export interface DocListViewProps {
  readonly documents: DocumentsApi;
  /** The indexer, for the filter's suggestions and note picker; optional. */
  readonly index?: ConditionIndex | undefined;
  /** Open a document; `line` deep-links a search result to the line that matched. */
  readonly onOpen: (id: string, line?: number) => void;
  readonly onCreate: () => void;
  readonly onDelete: (id: string) => Promise<void>;
  /** The `menu` port (`lm/context-menu`): the sort menu and each row's ⋯ menu. */
  readonly menu: Pick<ContextMenu, "open">;
  /**
   * Reports the ids the list holds, so `DocListApi.visible()` is not a guess: every
   * loaded row, including those scrolled out of the DOM by the virtual list.
   */
  readonly onRendered?: (ids: readonly string[]) => void;
  /** The search providers (`search/providers.ts`). */
  readonly search: SearchEngine;
  /** The search text — the URL's `?q=`, owned by the host. */
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** The search field, for the "Search documents" command. */
  readonly searchInput?: RefObject<HTMLInputElement>;
  /** The Actions menu for the listed results: every loaded row's id, and the button. */
  readonly onActions?: (ids: readonly string[], anchor: HTMLElement) => void;
}

export function DocListView({
  documents,
  index,
  menu,
  onOpen,
  onCreate,
  onDelete,
  onRendered,
  search,
  query: text,
  onQueryChange,
  searchInput,
  onActions,
}: DocListViewProps): ReactElement {
  const trimmed = text.trim();
  const searching = trimmed !== "";
  const [draft, setDraft] = useState<FilterDraft>({ combine: "and", clauses: [] });
  const [sortField, setSortField] = useState(searching ? RELEVANCE.field : "updated_at");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  // A search starts on "Best match" and, cleared, hands back the sort it interrupted.
  const interrupted = useRef<{ field: string; direction: "asc" | "desc" } | undefined>(
    searching ? { field: "updated_at", direction: "desc" } : undefined,
  );
  useEffect(() => {
    if (searching && interrupted.current === undefined) {
      interrupted.current = { field: sortField, direction: sortDirection };
      setSortField(RELEVANCE.field);
      setSortDirection("desc");
    } else if (!searching && interrupted.current !== undefined) {
      const previous = interrupted.current;
      interrupted.current = undefined;
      if (sortField === RELEVANCE.field) {
        setSortField(previous.field);
        setSortDirection(previous.direction);
      }
    }
    // Only the start and the end of a search move the sort; a pick in between stays.
  }, [searching]);
  const byRank = sortField === RELEVANCE.field;
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Two filters, and the difference matters. `filter` is what the *user* asked for and
  // decides which empty state to show; `effective` is what the query runs, and hides
  // machine-owned documents unless the draft asks for them (`_shared/machine-docs.ts`).
  // "Is inside note" is built from that note's children, watched live.
  const context = useConditionContext(documents, treeToWatch(draft));
  // No colours or icons here: those come from `folders`, which already depends on this
  // plugin (`lm/document-browser`), so asking it back would make a cycle.
  const notes = useMemo(
    () => (index !== undefined ? indexNoteSource(index) : documentsNoteSource(documents)),
    [documents, index],
  );
  const suggestions = useMemo(() => (index !== undefined ? indexSuggestions(index) : undefined), [index]);
  const filter = buildFilter(draft, context);
  const effective = buildEffectiveFilter(draft, context);
  const [pages, more] = usePages(JSON.stringify([effective, sortField, sortDirection, trimmed]));
  const found = useSearch(search, trimmed, { limit: limitFor(pages) });
  const ids = found.hits.map((hit) => hit.id);
  const query = useMemo<DocumentQuery>(() => {
    const within: FilterJson = { in: { field: "id", values: ids.map((id) => ({ str: id })) } };
    const filterJson = searching
      ? effective === undefined
        ? within
        : { and: [effective, within] }
      : effective;
    return {
      ...(filterJson !== undefined ? { filter: filterJson } : {}),
      sort: buildSort(byRank ? "updated_at" : sortField, sortDirection),
      limit: limitFor(pages),
    };
  }, [JSON.stringify(effective), sortDirection, sortField, pages, searching, ids.join(",")]);

  const live = useLiveQuery(documents, query);
  const state = useMemo(() => {
    if (!searching || !byRank) return live;
    const rank = new Map(ids.map((id, index) => [id, index]));
    const rows = [...live.rows].sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
    return { ...live, rows: sortDirection === "desc" ? rows : rows.reverse() };
  }, [live, searching, byRank, sortDirection, ids.join(",")]);
  const terms = useMemo(() => new Map(found.hits.map((hit) => [hit.id, hit.terms])), [found.hits]);
  // Providers that failed, offline the server one: its results need a connection.
  const partial = searching && found.results.some((result) => result.error !== undefined);
  // The providers have not answered this query yet (typing, or the debounce).
  const pending = searching && (found.running || found.settled !== trimmed);
  // More results may exist when the providers filled the page they were asked for.
  const moreResults = searching && found.hits.length >= limitFor(pages);
  const rendered = state.rows.map((row) => row.id).join(",");
  const virtual = useVirtualList({
    count: state.rows.length,
    keyOf: (index) => state.rows[index]?.id ?? String(index),
    // Title and meta; a search result's snippet is measured when it is drawn.
    estimate: searching ? 84 : 52,
  });

  useEffect(() => {
    onRendered?.(rendered === "" ? [] : rendered.split(","));
  }, [onRendered, rendered]);

  return (
    <section className="doclist doclist:flex doclist:flex-col doclist:gap-3 doclist:p-4 doclist:font-sans doclist:text-text doclist:compact:min-h-full doclist:compact:p-2 doclist:[&_:focus-visible]:outline-2 doclist:[&_:focus-visible]:outline-offset-1 doclist:[&_:focus-visible]:outline-focus doclist:[&_button]:tap-h doclist:[&_button]:cursor-pointer doclist:[&_button]:rounded doclist:[&_button]:border doclist:[&_button]:border-border doclist:[&_button]:bg-bg-subtle doclist:[&_button]:px-2 doclist:[&_button]:text-inherit doclist:disabled:[&_button]:cursor-default doclist:disabled:[&_button]:opacity-55" aria-labelledby="doclist-heading">
      {/* No create button here: Mod+N and the palette's "New document" are the way in. */}
      <header className="doclist-header doclist:flex doclist:items-center doclist:justify-between doclist:gap-2 doclist:[&_h2]:m-0">
        <h2 id="doclist-heading">Documents</h2>
      </header>

      <FilterBar
        menu={menu}
        draft={draft}
        onDraftChange={setDraft}
        sortField={sortField}
        sortDirection={sortDirection}
        onSortChange={(field, direction) => {
          setSortField(field);
          setSortDirection(direction);
        }}
        query={text}
        onQueryChange={onQueryChange}
        {...(searchInput ? { searchInput } : {})}
        notes={notes}
        {...(suggestions !== undefined ? { suggestions } : {})}
        context={context}
        {...(onActions && (searching || filter !== undefined) && state.rows.length > 0
          ? { onActions: (anchor: HTMLElement) => onActions(state.rows.map((row) => row.id), anchor) }
          : {})}
      />

      {partial && (
        <p className="doclist-search-note doclist:m-0 doclist:text-sm doclist:text-text-muted" role="status">
          Some results need a connection. These come from this device.
        </p>
      )}

      {state.error && (
        <p className="doclist-error doclist:m-0 doclist:rounded doclist:border doclist:border-danger doclist:p-2" role="alert">
          {state.error}
        </p>
      )}
      {error && (
        <p className="doclist-error doclist:m-0 doclist:rounded doclist:border doclist:border-danger doclist:p-2" role="alert">
          {error}
        </p>
      )}

      {(state.loading || pending) && state.rows.length === 0 ? (
        <p className="doclist-empty doclist:m-0 doclist:flex doclist:flex-col doclist:items-start doclist:gap-2 doclist:py-6 doclist:text-text-muted" role="status">
          {searching ? "Searching…" : "Loading…"}
        </p>
      ) : state.rows.length === 0 ? (
        searching ? (
          <p className="doclist-empty doclist:m-0 doclist:flex doclist:flex-col doclist:items-start doclist:gap-2 doclist:py-6 doclist:text-text-muted">
            Nothing matches “{trimmed}”.
          </p>
        ) : (
          <EmptyState hasFilter={filter !== undefined} onCreate={onCreate} />
        )
      ) : (
        <>
          <ul
            ref={virtual.listRef}
            className="doclist-items doclist:m-0 doclist:flex doclist:list-none doclist:flex-col doclist:p-0"
            style={{ paddingTop: virtual.before, paddingBottom: virtual.after }}
          >
            {state.rows.slice(virtual.first, virtual.end).map((row, offset) => {
              const snippet = searching ? snippetFor(row.content, terms.get(row.id) ?? []) : undefined;
              return (
              <li key={row.id} data-virtual-index={virtual.first + offset} className={`doclist-item doclist:grid doclist:grid-cols-[minmax(0,1fr)_auto] ${snippet ? "doclist:grid-rows-[auto_auto_auto]" : "doclist:grid-rows-2"} doclist:items-center doclist:gap-x-2 doclist:border-b doclist:border-border doclist:py-0.5 doclist:compact:py-1`}>
                <button
                  type="button"
                  className="doclist-open doclist:col-start-1 doclist:row-start-1 doclist:flex doclist:min-h-[calc(var(--lm-tap-target)/2)] doclist:min-w-0 doclist:items-center doclist:overflow-hidden doclist:text-ellipsis doclist:whitespace-nowrap doclist:border-0! doclist:bg-transparent! doclist:p-0! doclist:text-left doclist:text-lg doclist:text-link doclist:compact:min-h-[var(--lm-tap-target)]"
                  // Draggable so the `folders` tree can be dropped onto. The payload is a
                  // bare `text/plain` document id — no shared type and no import between
                  // plugins, which is the only way two plugins can agree on a drag
                  // (interaction goes through the registry or through the platform, never
                  // through a direct import — SPEC §6.1).
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", row.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onOpen(row.id, snippet?.line)}
                >
                  {row.title}
                </button>
                <Meta row={row} />
                {snippet && <SnippetLine snippet={snippet} />}
                <div className={`doclist-item-actions doclist:col-start-2 ${snippet ? "doclist:row-span-3" : "doclist:row-span-2"} doclist:row-start-1 doclist:compact:[&_button]:px-1.5 doclist:compact:[&_button]:text-sm`}>
                  <button
                    type="button"
                    className="doclist-row-menu doclist:inline-flex doclist:w-[var(--lm-tap-target)] doclist:items-center doclist:justify-center doclist:border-transparent! doclist:bg-transparent! doclist:p-0! doclist:text-text-muted doclist:hover:border-border! doclist:hover:text-text"
                    aria-haspopup="menu"
                    aria-label={`Actions for ${row.title}`}
                    disabled={busy === row.id}
                    onClick={(event) =>
                      menu.open({
                        title: row.title,
                        anchor: event.currentTarget,
                        sections: [
                          {
                            items: [
                              { id: "open", label: "Open", run: () => onOpen(row.id, snippet?.line) },
                              {
                                id: "trash",
                                label: "Move to Trash",
                                hint: "Restorable for 30 days.",
                                danger: true,
                                run: () => {
                                  setBusy(row.id);
                                  setError(undefined);
                                  void onDelete(row.id)
                                    .catch((cause: unknown) =>
                                      setError(cause instanceof Error ? cause.message : String(cause)),
                                    )
                                    .finally(() => setBusy(undefined));
                                },
                              },
                            ],
                          },
                        ],
                      })
                    }
                  >
                    ⋯
                  </button>
                </div>
              </li>
              );
            })}
          </ul>
          {(searching ? moreResults : state.rows.length < state.total) && (
            <LoadMore busy={state.loading || pending} onMore={more} />
          )}
          <p className="doclist-status doclist:m-0 doclist:text-sm doclist:text-text-muted" role="status" aria-live="polite">
            {searching
              ? `${state.rows.length.toLocaleString()}${moreResults ? "+" : ""} result${state.rows.length === 1 && !moreResults ? "" : "s"} for “${trimmed}”`
              : showingText(state.rows.length, state.total)}
          </p>
        </>
      )}
    </section>
  );
}

/** The line a search matched, its terms marked. */
function SnippetLine({ snippet }: { readonly snippet: Snippet }): ReactElement {
  return (
    <p className="doclist-snippet doclist:col-start-1 doclist:row-start-3 doclist:mb-1 doclist:mt-0 doclist:line-clamp-2 doclist:min-w-0 doclist:break-words doclist:text-sm doclist:text-text-muted doclist:[&_mark]:bg-selection doclist:[&_mark]:text-inherit">
      {splitHighlights(snippet).map((piece, index) =>
        piece.hit ? <mark key={index}>{piece.text}</mark> : <span key={index}>{piece.text}</span>,
      )}
    </p>
  );
}

export interface TrashViewProps {
  readonly documents: DocumentsApi;
  readonly onOpen: (id: string) => void;
  readonly onRestore: (id: string) => Promise<void>;
  /** From the server config; 30 by default (SPEC §3.5). */
  readonly retentionDays?: number;
  /**
   * The signed-in user's id, so `deleted_by` can be rendered as a sentence.
   *
   * The projection carries attribution as an id and nothing else, and there is no
   * `@kernel` way to turn one into a name (the user list is an admin endpoint). "you"
   * versus "someone else" is the whole of what this view can honestly say, and it is
   * also the distinction that matters in a shared workspace (SPEC §5.4) — a 26-character
   * ULID on screen said neither.
   */
  readonly currentUserId?: string;
}

export function TrashView({
  documents,
  onOpen,
  onRestore,
  retentionDays = 30,
  currentUserId,
}: TrashViewProps): ReactElement {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [newestFirst, setNewestFirst] = useState(true);
  const [pages, more] = usePages(String(newestFirst));

  const query = useMemo<DocumentQuery>(
    () => ({
      filter: TRASHED_ONLY,
      includeDeleted: true,
      sort: buildSort("deleted_at", newestFirst ? "desc" : "asc"),
      limit: limitFor(pages),
    }),
    [newestFirst, pages],
  );
  const state = useLiveQuery(documents, query);
  const rows = state.rows;

  return (
    <section className="doclist doclist:flex doclist:flex-col doclist:gap-3 doclist:p-4 doclist:font-sans doclist:text-text doclist:compact:p-2 doclist:[&_:focus-visible]:outline-2 doclist:[&_:focus-visible]:outline-offset-1 doclist:[&_:focus-visible]:outline-focus doclist:[&_button]:tap-h doclist:[&_button]:cursor-pointer doclist:[&_button]:rounded doclist:[&_button]:border doclist:[&_button]:border-border doclist:[&_button]:bg-bg-subtle doclist:[&_button]:px-2 doclist:[&_button]:text-inherit" aria-labelledby="trash-heading">
      <header className="doclist-header doclist:flex doclist:items-center doclist:justify-between doclist:gap-2 doclist:[&_h2]:m-0">
        <h2 id="trash-heading">Trash</h2>
        <button type="button" onClick={() => setNewestFirst((value) => !value)}>
          {newestFirst ? "Oldest first" : "Newest first"}
        </button>
      </header>

      <p className="doclist-note doclist:m-0 doclist:text-sm doclist:text-text-muted">Deleted documents are kept for {retentionDays} days.</p>

      {(state.error ?? error) && (
        <p className="doclist-error doclist:m-0 doclist:rounded doclist:border doclist:border-danger doclist:p-2" role="alert">
          {state.error ?? error}
        </p>
      )}

      {state.loading && rows.length === 0 ? (
        <p className="doclist-empty doclist:m-0 doclist:flex doclist:flex-col doclist:items-start doclist:gap-2 doclist:py-6 doclist:text-text-muted" role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="doclist-empty doclist:m-0 doclist:flex doclist:flex-col doclist:items-start doclist:gap-2 doclist:py-6 doclist:text-text-muted">Trash is empty.</p>
      ) : (
        <>
          <ul className="doclist-items doclist:m-0 doclist:flex doclist:list-none doclist:flex-col doclist:p-0">
            {rows.map((row) => (
              <li key={row.id} className="doclist-item doclist:grid doclist:grid-cols-[minmax(0,1fr)_auto] doclist:grid-rows-2 doclist:items-center doclist:gap-x-2 doclist:border-b doclist:border-border doclist:py-0.5 doclist:compact:py-1">
                <button type="button" className="doclist-open doclist:col-start-1 doclist:row-start-1 doclist:flex doclist:min-h-[calc(var(--lm-tap-target)/2)] doclist:min-w-0 doclist:items-center doclist:overflow-hidden doclist:text-ellipsis doclist:whitespace-nowrap doclist:border-0! doclist:bg-transparent! doclist:p-0! doclist:text-left doclist:text-lg doclist:text-link doclist:compact:min-h-[var(--lm-tap-target)]" onClick={() => onOpen(row.id)}>
                  {row.title}
                </button>
                <p className="doclist-meta doclist:col-start-1 doclist:row-start-2 doclist:mb-1 doclist:mt-0 doclist:flex doclist:min-w-0 doclist:flex-nowrap doclist:gap-2 doclist:overflow-hidden doclist:whitespace-nowrap doclist:text-sm doclist:text-text-muted doclist:[&>*]:shrink-0">
                  <span>deleted {formatWhen(row.deleted_at)}</span>
                  {row.deleted_by && (
                    <span title={`user ${row.deleted_by}`}>
                      by {row.deleted_by === currentUserId ? "you" : "another user"}
                    </span>
                  )}
                </p>
                <div className="doclist-item-actions doclist:col-start-2 doclist:row-span-2 doclist:row-start-1 doclist:compact:[&_button]:px-1.5 doclist:compact:[&_button]:text-sm">
                  <button
                    type="button"
                    disabled={busy === row.id}
                    onClick={() => {
                      setBusy(row.id);
                      setError(undefined);
                      void onRestore(row.id)
                        .catch((cause: unknown) =>
                          setError(cause instanceof Error ? cause.message : String(cause)),
                        )
                        .finally(() => setBusy(undefined));
                    }}
                  >
                    Restore
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {rows.length < state.total && (
            <LoadMore busy={state.loading} onMore={more} />
          )}
          <p className="doclist-status doclist:m-0 doclist:text-sm doclist:text-text-muted" role="status" aria-live="polite">
            {rows.length < state.total
              ? showingText(rows.length, state.total)
              : `${state.total.toLocaleString()} deleted document${state.total === 1 ? "" : "s"}`}
          </p>
        </>
      )}
    </section>
  );
}

function EmptyState({
  hasFilter,
  onCreate,
}: {
  readonly hasFilter: boolean;
  readonly onCreate: () => void;
}): ReactElement {
  // One line and one action. The markdown tutorial that used to sit here is what the
  // seeded welcome documents are for, and the reassurance that filtering is local was a
  // sentence answering a question nobody had asked.
  if (hasFilter) {
    return <p className="doclist-empty doclist:m-0 doclist:flex doclist:flex-col doclist:items-start doclist:gap-2 doclist:py-6 doclist:text-text-muted">No document matches. Clear the filter.</p>;
  }
  return (
    <div className="doclist-empty doclist:m-0 doclist:flex doclist:flex-col doclist:items-start doclist:gap-2 doclist:py-6 doclist:text-text-muted">
      <p>No documents yet.</p>
      <button type="button" className="doclist-primary doclist:border-accent! doclist:bg-accent! doclist:text-accent-text!" onClick={onCreate}>
        Create the first document
      </button>
    </div>
  );
}

function Meta({ row }: { readonly row: DocumentRow }): ReactElement {
  return (
    <p className="doclist-meta doclist:col-start-1 doclist:row-start-2 doclist:mb-1 doclist:mt-0 doclist:flex doclist:min-w-0 doclist:flex-nowrap doclist:gap-2 doclist:overflow-hidden doclist:whitespace-nowrap doclist:text-sm doclist:text-text-muted doclist:[&>*]:shrink-0">
      <span>updated {formatWhen(row.updated_at)}</span>
      {row.fm_parse_error && (
        <span className="doclist-warning doclist:text-warning" title="Some frontmatter lines could not be parsed">
          frontmatter problem
        </span>
      )}
    </p>
  );
}

/**
 * Timestamps are shown, never compared: ordering is `seq` and the CRDT (PROTOCOL.md §5),
 * and this is a label.
 */
function formatWhen(iso: string | null): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
