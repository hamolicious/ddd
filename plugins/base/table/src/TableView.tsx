import type { ReactElement } from "react";

import { splitHighlights } from "../../_shared/highlights.js";
import type { SavedViewProps } from "../../_shared/saved-view-mode.js";

import { tableFromOptions } from "./columns.js";
import { ResultsTable } from "./ResultsTable.js";

export function TableView({
  results,
  options,
  sort,
  onSortChange,
  onOpen,
  openMenu,
}: SavedViewProps & { readonly openMenu: (element: HTMLElement) => void }): ReactElement {
  const table = tableFromOptions(options);
  return (
    <ResultsTable
      rows={results.rows}
      columns={table.columns}
      rowLimit={table.rows}
      snippetOf={results.snippetOf}
      renderSnippet={(snippet) => (
        <p className="search-snippet table:m-0 table:line-clamp-2 table:min-w-0 table:break-words table:text-sm table:text-text-muted table:[&_mark]:bg-selection table:[&_mark]:text-inherit">
          {splitHighlights(snippet).map((piece, index) =>
            piece.hit ? <mark key={index}>{piece.text}</mark> : <span key={index}>{piece.text}</span>,
          )}
        </p>
      )}
      sortField={sort.field}
      sortDirection={sort.direction}
      onSort={(field, direction) => onSortChange({ field, direction })}
      onOpen={onOpen}
      onRowMenu={openMenu}
      more={results.hasMore ? { busy: results.loading, onMore: results.more } : undefined}
    />
  );
}

export const TABLE_ICON = (
  <svg aria-hidden="true" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 9h18M9 9v11M15 9v11" />
  </svg>
);
