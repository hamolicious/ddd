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
 * with more tombstones than `TRASH_LIMIT` showed the wrong ones in a confident order.
 * `deleted_at` is a fixed root of the DSL now (`core::filter::ast::FIXED_ROOTS`), the
 * server compiles it, and `kernel/src/query/filter.ts` mirrors it — so the sort key is
 * just a sort key, and the direction toggle is one query parameter.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";

import type { DocumentQuery, DocumentRow, DocumentsApi } from "@kernel";

import { FilterBar } from "./FilterBar.js";
import {
  TRASHED_ONLY,
  buildEffectiveFilter,
  buildFilter,
  buildSort,
  type FilterDraft,
} from "./filter.js";
import { useLiveQuery } from "./useLiveQuery.js";

/** Trash holds at most 30 days of tombstones; one page covers a realistic workspace. */
const TRASH_LIMIT = 1_000;
const LIST_LIMIT = 200;

export interface DocListViewProps {
  readonly documents: DocumentsApi;
  readonly onOpen: (id: string) => void;
  readonly onCreate: () => void;
  readonly onDelete: (id: string) => Promise<void>;
  /** Reports the ids currently rendered, so `DocListApi.visible()` is not a guess. */
  readonly onRendered?: (ids: readonly string[]) => void;
}

export function DocListView({
  documents,
  onOpen,
  onCreate,
  onDelete,
  onRendered,
}: DocListViewProps): ReactElement {
  const [draft, setDraft] = useState<FilterDraft>({ combine: "and", clauses: [], titleContains: "" });
  const [sortField, setSortField] = useState("updated_at");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Two filters, and the difference matters. `filter` is what the *user* asked for and
  // decides which empty state to show; `effective` is what the query runs, and hides
  // machine-owned documents unless the draft asks for them (`_shared/machine-docs.ts`).
  const filter = buildFilter(draft);
  const effective = buildEffectiveFilter(draft);
  const query = useMemo<DocumentQuery>(
    () => ({
      ...(effective !== undefined ? { filter: effective } : {}),
      sort: buildSort(sortField, sortDirection),
      limit: LIST_LIMIT,
    }),
    [JSON.stringify(effective), sortDirection, sortField],
  );

  const state = useLiveQuery(documents, query);
  const rendered = state.rows.map((row) => row.id).join(",");

  useEffect(() => {
    onRendered?.(rendered === "" ? [] : rendered.split(","));
  }, [onRendered, rendered]);

  return (
    <section className="doclist doclist:flex doclist:flex-col doclist:gap-3 doclist:p-4 doclist:font-sans doclist:text-text doclist:compact:p-2 doclist:[&_:focus-visible]:outline-2 doclist:[&_:focus-visible]:outline-offset-1 doclist:[&_:focus-visible]:outline-focus doclist:[&_button]:tap-h doclist:[&_button]:cursor-pointer doclist:[&_button]:rounded doclist:[&_button]:border doclist:[&_button]:border-border doclist:[&_button]:bg-bg-subtle doclist:[&_button]:px-2 doclist:[&_button]:text-inherit doclist:disabled:[&_button]:cursor-default doclist:disabled:[&_button]:opacity-55" aria-labelledby="doclist-heading">
      <header className="doclist-header doclist:flex doclist:items-center doclist:justify-between doclist:gap-2 doclist:[&_h2]:m-0">
        <h2 id="doclist-heading">Documents</h2>
        <button type="button" className="doclist-primary doclist:border-accent! doclist:bg-accent! doclist:text-accent-text!" onClick={onCreate}>
          New document
        </button>
      </header>

      <FilterBar
        draft={draft}
        onDraftChange={setDraft}
        sortField={sortField}
        sortDirection={sortDirection}
        onSortChange={(field, direction) => {
          setSortField(field);
          setSortDirection(direction);
        }}
      />

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

      {state.loading ? (
        <p className="doclist-empty doclist:m-0 doclist:flex doclist:flex-col doclist:items-start doclist:gap-2 doclist:py-6 doclist:text-text-muted" role="status">
          Loading…
        </p>
      ) : state.rows.length === 0 ? (
        <EmptyState hasFilter={filter !== undefined} onCreate={onCreate} />
      ) : (
        <>
          <ul className="doclist-items doclist:m-0 doclist:flex doclist:list-none doclist:flex-col doclist:p-0">
            {state.rows.map((row) => (
              <li key={row.id} className="doclist-item doclist:grid doclist:grid-cols-[minmax(0,1fr)_auto] doclist:grid-rows-2 doclist:items-center doclist:gap-x-2 doclist:border-b doclist:border-border doclist:py-0.5 doclist:compact:py-1">
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
                  onClick={() => onOpen(row.id)}
                >
                  {row.title}
                </button>
                <Meta row={row} />
                <div className="doclist-item-actions doclist:col-start-2 doclist:row-span-2 doclist:row-start-1 doclist:compact:[&_button]:px-1.5 doclist:compact:[&_button]:text-sm">
                  <button
                    type="button"
                    disabled={busy === row.id}
                    onClick={() => {
                      setBusy(row.id);
                      setError(undefined);
                      void onDelete(row.id)
                        .catch((cause: unknown) =>
                          setError(cause instanceof Error ? cause.message : String(cause)),
                        )
                        .finally(() => setBusy(undefined));
                    }}
                  >
                    Move to Trash
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="doclist-status doclist:m-0 doclist:text-sm doclist:text-text-muted" role="status" aria-live="polite">
            Showing {state.rows.length} of {state.total}
            {state.total > LIST_LIMIT ? ` (first ${LIST_LIMIT})` : ""}
          </p>
        </>
      )}
    </section>
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

  const query = useMemo<DocumentQuery>(
    () => ({
      filter: TRASHED_ONLY,
      includeDeleted: true,
      sort: buildSort("deleted_at", newestFirst ? "desc" : "asc"),
      limit: TRASH_LIMIT,
    }),
    [newestFirst],
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

      {state.loading ? (
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
          <p className="doclist-status doclist:m-0 doclist:text-sm doclist:text-text-muted" role="status" aria-live="polite">
            {rows.length} deleted document{rows.length === 1 ? "" : "s"}
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
  const path = typeof row.fm["path"] === "string" ? row.fm["path"] : undefined;
  return (
    <p className="doclist-meta doclist:col-start-1 doclist:row-start-2 doclist:mb-1 doclist:mt-0 doclist:flex doclist:min-w-0 doclist:flex-nowrap doclist:gap-2 doclist:overflow-hidden doclist:whitespace-nowrap doclist:text-sm doclist:text-text-muted doclist:[&>*]:shrink-0">
      {path && <span className="doclist-path doclist:min-w-[3ch] doclist:shrink doclist:overflow-hidden doclist:text-ellipsis doclist:font-mono">{path}</span>}
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
