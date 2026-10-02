import type { ReactElement } from "react";

import type { DocumentsApi } from "@kernel";

import { EXCLUDE_MACHINE_DOCUMENTS } from "../../_shared/machine-docs.js";

import { useLiveQuery } from "../../_shared/useLiveQuery.js";

import { TRASHED_ONLY } from "./DocListView.js";

export interface ViewsPanelProps {
  readonly documents: DocumentsApi;
  readonly onNavigate: (path: string) => void;
  readonly current: string;
}

export function ViewsPanel({ documents, onNavigate, current }: ViewsPanelProps): ReactElement {
  const live = useLiveQuery(documents, { filter: EXCLUDE_MACHINE_DOCUMENTS, limit: 1 });
  const trashed = useLiveQuery(documents, { filter: TRASHED_ONLY, includeDeleted: true, limit: 1 });

  const entries = [
    { path: "/", label: "All documents", count: live.total },
    { path: "/trash", label: "Trash", count: trashed.total },
  ] as const;

  return (
    <nav className="doclist-views" aria-label="Document views">
      <ul className="doclist:m-0 doclist:list-none doclist:p-0">
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
