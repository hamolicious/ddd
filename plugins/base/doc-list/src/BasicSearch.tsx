import { useEffect } from "react";
import type { ComponentType, ReactElement, RefObject } from "react";

import type { SearchApi } from "@kernel";
import type { SearchResults } from "plugin:search";

import { useBasicResults } from "./basic-results.js";
import type { NoteListProps } from "./NoteList.js";

export interface BasicSearchProps {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onAdvanced: () => void;
  readonly onOpen: (id: string, line?: number) => void;
  readonly onRendered: (ids: readonly string[]) => void;
  readonly searchInput: RefObject<HTMLInputElement>;
  readonly search: SearchApi;
  readonly NoteList: ComponentType<NoteListProps>;
}

export function basicStatus(results: Pick<SearchResults, "rows" | "total">, query: string): string {
  const total = results.total ?? results.rows.length;
  const text = query.trim();
  if (text === "") return `${total.toLocaleString()} document${total === 1 ? "" : "s"}`;
  return `${total.toLocaleString()} result${total === 1 ? "" : "s"} for “${text}”`;
}

export function BasicSearch({
  query,
  onQueryChange,
  onAdvanced,
  onOpen,
  onRendered,
  searchInput,
  search,
  NoteList,
}: BasicSearchProps): ReactElement {
  const results = useBasicResults(search, query);
  const text = query.trim();
  const rendered = results.rows.map((row) => row.id).join(",");
  useEffect(() => {
    onRendered(rendered === "" ? [] : rendered.split(","));
  }, [rendered, onRendered]);

  return (
    <section
      className="doclist doclist-basic doclist:flex doclist:flex-col doclist:gap-3 doclist:p-4 doclist:font-sans doclist:text-text doclist:compact:min-h-full doclist:compact:p-2 doclist:[&_:focus-visible]:outline-2 doclist:[&_:focus-visible]:outline-offset-1 doclist:[&_:focus-visible]:outline-focus doclist:[&_button]:tap-h doclist:[&_button]:cursor-pointer doclist:[&_button]:rounded doclist:[&_button]:border doclist:[&_button]:border-border doclist:[&_button]:bg-bg-subtle doclist:[&_button]:px-2 doclist:[&_button]:text-inherit"
      aria-label="Documents"
    >
      <header className="doclist-header doclist:flex doclist:items-center doclist:justify-between doclist:gap-2 doclist:[&_h2]:m-0">
        <h2>Documents</h2>
      </header>
      <div className="doclist-basic-bar doclist:flex doclist:items-center doclist:gap-2">
        <label className="doclist:relative doclist:flex doclist:min-w-0 doclist:flex-1 doclist:items-center">
          <span className="doclist:sr-only">Search documents</span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            className="doclist:pointer-events-none doclist:absolute doclist:left-2.5 doclist:size-[1.05em] doclist:text-text-muted"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="M16 16l4.5 4.5" />
          </svg>
          <input
            ref={searchInput}
            className="doclist-basic-input doclist:tap-h doclist:w-full doclist:min-w-0 doclist:rounded doclist:border doclist:border-border doclist:bg-bg doclist:py-0 doclist:pl-8 doclist:pr-2 doclist:text-base doclist:text-text"
            type="search"
            value={query}
            spellCheck={false}
            autoComplete="off"
            enterKeyHint="search"
            placeholder="Search documents"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
        <button type="button" className="doclist-advanced doclist:whitespace-nowrap" onClick={onAdvanced}>
          Advanced search
        </button>
      </div>
      {results.error && (
        <p className="doclist-error doclist:m-0 doclist:rounded doclist:border doclist:border-danger doclist:p-2" role="alert">
          {results.error}
        </p>
      )}
      {results.rows.length === 0 ? (
        results.loading ? (
          <div className="doclist-empty doclist:min-h-16" />
        ) : (
          <p className="doclist-empty doclist:m-0 doclist:py-6 doclist:text-text-muted">
            {text === "" ? "No documents yet." : `Nothing matches “${text}”.`}
          </p>
        )
      ) : (
        <>
          <NoteList results={results} onOpen={onOpen} searchInput={searchInput} />
          <p className="doclist-status doclist:m-0 doclist:text-sm doclist:text-text-muted" role="status" aria-live="polite">
            {basicStatus(results, query)}
          </p>
        </>
      )}
    </section>
  );
}
