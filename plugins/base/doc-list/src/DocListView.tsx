/**
 * The main document list, and the Trash view, which are the same list with two rules
 * changed.
 *
 * **Trash is `includeDeleted` plus a filter, not another store** (SPEC §3.5): a
 * tombstoned document is an ordinary projection row with `deleted: true`, restorable for
 * 30 days, and purge is the server's job.
 *
 * **Trash sorts client-side.** `?sort=deleted_at` is a 400 and the local evaluator
 * resolves that root to `Missing`, so neither engine can order by it (`filter.ts` has the
 * full argument). The rows are therefore ordered here, after the query, and the UI says
 * so rather than showing a control that lies — which is also why Trash asks for a
 * generous `limit`: the ordering is only correct over the rows it actually holds.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";

import type { DocumentQuery, DocumentRow, DocumentsApi } from "@kernel";

import { FilterBar } from "./FilterBar.js";
import { TRASHED_ONLY, buildFilter, buildSort, type FilterDraft } from "./filter.js";
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

  const filter = buildFilter(draft);
  const query = useMemo<DocumentQuery>(
    () => ({
      ...(filter !== undefined ? { filter } : {}),
      sort: buildSort(sortField, sortDirection),
      limit: LIST_LIMIT,
    }),
    [JSON.stringify(filter), sortDirection, sortField],
  );

  const state = useLiveQuery(documents, query);
  const rendered = state.rows.map((row) => row.id).join(",");

  useEffect(() => {
    onRendered?.(rendered === "" ? [] : rendered.split(","));
  }, [onRendered, rendered]);

  return (
    <section className="doclist" aria-labelledby="doclist-heading">
      <header className="doclist-header">
        <h2 id="doclist-heading">Documents</h2>
        <button type="button" className="doclist-primary" onClick={onCreate}>
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
        <p className="doclist-error" role="alert">
          {state.error}
        </p>
      )}
      {error && (
        <p className="doclist-error" role="alert">
          {error}
        </p>
      )}

      {state.loading ? (
        <p className="doclist-empty" role="status">
          Loading…
        </p>
      ) : state.rows.length === 0 ? (
        <EmptyState hasFilter={filter !== undefined} onCreate={onCreate} />
      ) : (
        <>
          <ul className="doclist-items">
            {state.rows.map((row) => (
              <li key={row.id} className="doclist-item">
                <button
                  type="button"
                  className="doclist-open"
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
                <div className="doclist-item-actions">
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
          <p className="doclist-status" role="status" aria-live="polite">
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
}

export function TrashView({
  documents,
  onOpen,
  onRestore,
  retentionDays = 30,
}: TrashViewProps): ReactElement {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [newestFirst, setNewestFirst] = useState(true);

  const query = useMemo<DocumentQuery>(
    () => ({
      filter: TRASHED_ONLY,
      includeDeleted: true,
      // Ordered again below; `updated_at` only keeps the query's own order stable.
      sort: buildSort("updated_at", "desc"),
      limit: TRASH_LIMIT,
    }),
    [],
  );
  const state = useLiveQuery(documents, query);

  const rows = useMemo(() => {
    const ordered = [...state.rows].sort((a, b) => {
      const left = a.deleted_at ?? "";
      const right = b.deleted_at ?? "";
      if (left !== right) return left < right ? -1 : 1;
      // Same instant: the id tiebreaker both engines use, so the order is total.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return newestFirst ? ordered.reverse() : ordered;
  }, [newestFirst, state.rows]);

  return (
    <section className="doclist" aria-labelledby="trash-heading">
      <header className="doclist-header">
        <h2 id="trash-heading">Trash</h2>
        <button type="button" onClick={() => setNewestFirst((value) => !value)}>
          {newestFirst ? "Oldest first" : "Newest first"}
        </button>
      </header>

      <p className="doclist-note">
        Documents stay here for {retentionDays} days, then the server purges them
        permanently. Restoring brings a document back exactly as it was.
      </p>
      <p className="doclist-note">
        Sorted by deletion time <strong>on this device</strong>: the shared filter language
        does not reach <code>deleted_at</code>, so neither the server nor the local query
        engine can order by it — see <code>filter.ts</code>. The ordering therefore covers
        the {TRASH_LIMIT} most recently updated tombstones.
      </p>

      {(state.error ?? error) && (
        <p className="doclist-error" role="alert">
          {state.error ?? error}
        </p>
      )}

      {state.loading ? (
        <p className="doclist-empty" role="status">
          Loading…
        </p>
      ) : rows.length === 0 ? (
        <p className="doclist-empty">
          Trash is empty. Deleted documents appear here for {retentionDays} days.
        </p>
      ) : (
        <>
          <ul className="doclist-items">
            {rows.map((row) => (
              <li key={row.id} className="doclist-item">
                <button type="button" className="doclist-open" onClick={() => onOpen(row.id)}>
                  {row.title}
                </button>
                <p className="doclist-meta">
                  <span>deleted {formatWhen(row.deleted_at)}</span>
                  {row.deleted_by && <span>by {row.deleted_by}</span>}
                </p>
                <div className="doclist-item-actions">
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
          <p className="doclist-status" role="status" aria-live="polite">
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
  if (hasFilter) {
    return (
      <p className="doclist-empty">
        No document matches these conditions. Clearing them shows everything — the filter
        runs on this device, so it is not a connection problem.
      </p>
    );
  }
  return (
    <div className="doclist-empty">
      <p>No documents yet.</p>
      <p>
        Everything here is one markdown file: <code>---</code> frontmatter at the top, text
        in the middle. Put <code>path: home/lists</code> in the frontmatter and it appears
        in the folder tree.
      </p>
      <button type="button" className="doclist-primary" onClick={onCreate}>
        Create the first document
      </button>
    </div>
  );
}

function Meta({ row }: { readonly row: DocumentRow }): ReactElement {
  const path = typeof row.fm["path"] === "string" ? row.fm["path"] : undefined;
  return (
    <p className="doclist-meta">
      {path && <span className="doclist-path">{path}</span>}
      <span>updated {formatWhen(row.updated_at)}</span>
      {row.fm_parse_error && (
        <span className="doclist-warning" title="Some frontmatter lines could not be parsed">
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
