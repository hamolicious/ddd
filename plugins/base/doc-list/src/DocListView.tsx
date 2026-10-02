import { useMemo, useState } from "react";
import type { ReactElement } from "react";

import type { DocumentQuery, DocumentsApi, FilterJson, SortKey } from "@kernel";

import { LoadMore } from "../../_shared/LoadMore.js";
import { limitFor, showingText, usePages } from "../../_shared/pagination.js";
import { useLiveQuery } from "../../_shared/useLiveQuery.js";

export const TRASHED_ONLY: FilterJson = { cmp: { field: "deleted", op: "eq", value: { bool: true } } };

const buildSort = (field: string, direction: "asc" | "desc"): readonly SortKey[] => [{ field, direction }];

export interface TrashViewProps {
  readonly documents: DocumentsApi;
  readonly onOpen: (id: string) => void;
  readonly onRestore: (id: string) => Promise<void>;
  readonly retentionDays?: number;
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
                <button type="button" className="doclist-open doclist:col-start-1 doclist:row-start-1 doclist:flex doclist:min-h-[calc(var(--ddd-tap-target)/2)] doclist:min-w-0 doclist:items-center doclist:overflow-hidden doclist:text-ellipsis doclist:whitespace-nowrap doclist:border-0! doclist:bg-transparent! doclist:p-0! doclist:text-left doclist:text-lg doclist:text-link doclist:compact:min-h-[var(--ddd-tap-target)]" onClick={() => onOpen(row.id)}>
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

function formatWhen(iso: string | null): string {
  if (!iso) return "unknown";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
