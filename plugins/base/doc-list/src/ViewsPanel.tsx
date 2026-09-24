/**
 * The "Views" sidebar panel: All documents, Recent, Trash.
 *
 * The counts are live queries, not a refresh on navigation — a document deleted in
 * another tab moves between the two numbers as the feed arrives. They are also cheap:
 * `limit: 1` asks the query engine for the total without materializing rows.
 */

import type { ReactElement } from "react";

import type { DocumentsApi } from "@kernel";

import { TRASHED_ONLY } from "./filter.js";
import { useLiveQuery } from "./useLiveQuery.js";

export interface ViewsPanelProps {
  readonly documents: DocumentsApi;
  readonly onNavigate: (path: string) => void;
  /** The current hash path, so the active view is marked. */
  readonly current: string;
}

export function ViewsPanel({ documents, onNavigate, current }: ViewsPanelProps): ReactElement {
  const live = useLiveQuery(documents, { limit: 1 });
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
              className={`doclist-view${current === entry.path ? " doclist-view-active" : ""}`}
              aria-current={current === entry.path ? "page" : undefined}
              onClick={() => onNavigate(entry.path)}
            >
              <span>{entry.label}</span>
              {entry.count !== undefined && <span className="doclist-count">{entry.count}</span>}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
