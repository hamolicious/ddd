/**
 * The "Views" sidebar panel: All documents, Recent, Trash.
 *
 * The counts are live queries, not a refresh on navigation — a document deleted in
 * another tab moves between the two numbers as the feed arrives. They are also cheap:
 * `limit: 1` asks the query engine for the total without materializing rows.
 *
 * **"All documents" counts what the list shows**, which excludes machine-owned
 * documents (`_shared/machine-docs.ts`). The two have to agree: a sidebar saying 12
 * above a list of 11 rows is a bug report waiting to be filed, and the settings
 * document it was counting is not something the reader thinks of as one of their
 * documents. Turning the list's "show machine documents" on does not change this
 * number, deliberately — it is the count of the default view, and the list's own
 * header is where a filtered total belongs.
 */

import type { ReactElement } from "react";

import type { DocumentsApi } from "@kernel";

import { EXCLUDE_MACHINE_DOCUMENTS } from "../../_shared/machine-docs.js";

import { TRASHED_ONLY } from "./filter.js";
import { useLiveQuery } from "./useLiveQuery.js";

export interface ViewsPanelProps {
  readonly documents: DocumentsApi;
  readonly onNavigate: (path: string) => void;
  /** The current hash path, so the active view is marked. */
  readonly current: string;
}

export function ViewsPanel({ documents, onNavigate, current }: ViewsPanelProps): ReactElement {
  const live = useLiveQuery(documents, { filter: EXCLUDE_MACHINE_DOCUMENTS, limit: 1 });
  const trashed = useLiveQuery(documents, { filter: TRASHED_ONLY, includeDeleted: true, limit: 1 });

  // Two entries, both of which are real routes. "Recent" is not here because the default
  // list is already sorted by `updated_at` — a second link to the same rows is a dead
  // control with an extra name.
  const entries = [
    { path: "/", label: "All documents", count: live.total },
    { path: "/trash", label: "Trash", count: trashed.total },
  ] as const;

  return (
    <nav className="doclist-views" aria-label="Document views">
      <ul>
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className={`doclist-view doclist:tap-h doclist:flex doclist:w-full doclist:cursor-pointer doclist:items-center doclist:justify-between doclist:gap-2 doclist:rounded doclist:border-0 doclist:px-2 doclist:text-left doclist:font-sans doclist:text-text doclist:hover:bg-bg-subtle ${current === entry.path ? " doclist-view-active doclist:bg-accent-subtle" : " doclist:bg-transparent"}`}
              aria-current={current === entry.path ? "page" : undefined}
              onClick={() => onNavigate(entry.path)}
            >
              <span>{entry.label}</span>
              {entry.count !== undefined && <span className="doclist-count doclist:text-sm doclist:tabular-nums doclist:text-text-muted">{entry.count}</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
