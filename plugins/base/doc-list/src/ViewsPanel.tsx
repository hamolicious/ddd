import { useMemo, type ReactElement } from "react";

import type { SearchApi } from "@kernel";

import { notMachine, useLiveSearch } from "../../_shared/live-search.js";

export interface ViewsPanelProps {
  readonly search: SearchApi;
  readonly onNavigate: (path: string) => void;
  readonly current: string;
}

export function ViewsPanel({ search, onNavigate, current }: ViewsPanelProps): ReactElement {
  const liveCount = useMemo(() => search.from().where(notMachine).count(), [search]);
  const trashedCount = useMemo(() => search.from().trash("trashed").count(), [search]);
  const live = { total: useLiveSearch(liveCount).rows[0]?.count };
  const trashed = { total: useLiveSearch(trashedCount).rows[0]?.count };

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
