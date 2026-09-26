/**
 * The full results page (`#/search?q=…`).
 *
 * Results are grouped by nothing by default — one merged, ranked list is what a person
 * wants — but every row says which provider(s) found it, and the per-provider counts are
 * a disclosure under the list rather than a strip above it. The strip was three numbers
 * and two nouns immediately above "2 results", which is a whole phone screen spent on
 * arithmetic; a provider that *failed* is still called out in words, because "the server
 * index is unreachable" is information an offline client needs (SPEC §4.1).
 *
 * The three empty states SPEC §6.5 asks for by name are all here: no query, no matches,
 * and "the index is still building" — the last one inferred from a local provider that
 * returned nothing while the workspace is not empty, because a cold search index is
 * exactly when a user concludes the app lost their documents.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import { snippetFor, splitHighlights } from "./merge.js";
import { useProviderErrors, useSearch, type SearchEngine } from "./useSearch.js";

export interface ResultsViewProps {
  readonly engine: SearchEngine;
  /** The query from the URL, re-read on every hash change by the host. */
  readonly initialQuery: string;
  /**
   * Open a result. `line` is the 1-based line of the snippet, so the host can deep-link
   * to the match (`#/doc/<id>?line=42`) instead of dropping the reader at the top of a
   * long document and leaving them to find it again.
   */
  readonly onOpenDocument: (id: string, line?: number) => void;
  /** Push the query into the URL, so a result page is linkable. */
  readonly onQueryChange: (query: string) => void;
  /** Total live documents, for the "index still building" distinction. */
  readonly documentCount?: number;
}

export function ResultsView({
  engine,
  initialQuery,
  onOpenDocument,
  onQueryChange,
  documentCount,
}: ResultsViewProps): ReactElement {
  const [query, setQuery] = useState(initialQuery);
  // Not in the URL: it is a preference about this list, not part of the address a
  // person shares. A shared `#/search?q=…` link should show the other reader the
  // default view, not whatever the sender happened to have toggled.
  const [includeMachine, setIncludeMachine] = useState(false);

  // The URL is the source of truth: a back/forward navigation or a link from the box
  // must move the page, not be overwritten by stale local state.
  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const state = useSearch(engine, query, { limit: 100, includeMachine });
  const failures = useProviderErrors(state);
  const trimmed = query.trim();

  return (
    <section className="search:flex search:flex-col search:gap-3 search:p-4 search:font-sans search:text-text search:compact:p-2 search:[&_:focus-visible]:outline-2 search:[&_:focus-visible]:outline-offset-1 search:[&_:focus-visible]:outline-focus search:[&_h2]:m-0" aria-labelledby="search-results-heading">
      <h2 id="search-results-heading">Search</h2>

      <form
        className="search:flex search:flex-wrap search:items-stretch search:gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onQueryChange(query);
        }}
      >
        <label className="search:flex-1">
          <span className="search:sr-only">Search documents</span>
          <input
            className="search:tap-h search:w-full search:rounded search:border search:border-border search:bg-bg search:px-2 search:text-inherit"
            type="search"
            value={query}
            autoFocus
            spellCheck={false}
            placeholder="Search every document…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit" className="search:tap-h search:cursor-pointer search:rounded search:border search:border-accent search:bg-accent search:px-4 search:text-accent-text search:compact:px-2">Search</button>
        <label className="search:tap-h search:flex search:cursor-pointer search:items-center search:gap-1 search:whitespace-nowrap search:text-sm search:text-text-muted">
          <input
            type="checkbox"
            checked={includeMachine}
            onChange={(event) => setIncludeMachine(event.target.checked)}
          />
          <span title="Documents plugins keep for themselves.">Include machine documents</span>
        </label>
      </form>

      {/*
        One number on screen, the split behind a disclosure.
        The strip used to read "This device: 3 hits  Server: 3 hits" directly above
        "2 results for document" — three numbers and two nouns for one list, on a
        screen that has room for about one. Which source found a row is still on the
        row; how many each returned is a question, not a headline.
      */}
      {state.results.length > 0 && trimmed !== "" && (
        <details className="search:text-sm search:text-text-muted search:[&>summary]:flex search:[&>summary]:min-h-[var(--lm-tap-target)] search:[&>summary]:cursor-pointer search:[&>summary]:items-center">
          <summary>Where these came from</summary>
          <ul className="search:m-0 search:flex search:list-none search:flex-wrap search:gap-3 search:p-0 search:text-sm search:text-text-muted" aria-label="Sources">
            {state.results.map((result) => (
              <li
                key={result.providerId}
                className={result.error ? "search:text-warning" : undefined}
              >
                {result.label}:{" "}
                {result.error ? (
                  <span>unavailable: {result.error}</span>
                ) : (
                  `${result.hits.length} result${result.hits.length === 1 ? "" : "s"}`
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {failures.length > 0 && (
        <p className="search:m-0 search:text-text-muted" role="status">
          Some results need a connection. These come from this device.
        </p>
      )}

      {trimmed === "" ? (
        <p className="search:m-0 search:text-text-muted">Search titles, text and properties.</p>
      ) : state.running ? (
        <p className="search:m-0 search:text-text-muted" role="status">
          Searching…
        </p>
      ) : state.hits.length === 0 ? (
        <p className="search:m-0 search:text-text-muted">
          Nothing matches “{trimmed}”.
          {/*
            The one hedge left, and it is down to a clause. `@kernel` reports no index
            status (see the INTEGRATION note in this plugin's README section), so
            "documents exist and nothing matched" is still the closest this view can get
            to "the index is cold" — but three sentences of it under every failed search
            read as an excuse rather than a state.
          */}
          {documentCount !== undefined && documentCount > 0 && (
            <> The local index may still be building; this page updates when it finishes.</>
          )}
        </p>
      ) : (
        <ol className="search:m-0 search:flex search:list-none search:flex-col search:gap-3 search:p-0">
          {state.hits.map((hit) => {
            const row = state.rows.get(hit.id);
            const snippet = snippetFor(row?.content, hit.terms);
            return (
              <li key={hit.id}>
                <button
                  type="button"
                  className="search-result-open search:tap-h search:max-w-full search:cursor-pointer search:break-words search:border-0 search:bg-transparent search:p-0 search:text-left search:text-lg search:text-link"
                  onClick={() => onOpenDocument(hit.id, snippet?.line)}
                >
                  {row?.title ?? hit.id}
                </button>
                <p className="search:my-0.5 search:flex search:min-w-0 search:flex-wrap search:gap-2 search:text-sm search:text-text-muted">
                  {typeof row?.fm["path"] === "string" && row.fm["path"] !== "" && (
                    <span className="search:min-w-0 search:break-words search:font-mono">{String(row.fm["path"])}</span>
                  )}
                  <span>{hit.providers.join(", ")}</span>
                </p>
                {snippet && (
                  <p className="search:line-clamp-3 search:break-words search:text-[0.88em] search:text-text-muted search:[&_mark]:bg-selection search:[&_mark]:text-inherit">
                    {splitHighlights(snippet).map((piece, index) =>
                      piece.hit ? <mark key={index}>{piece.text}</mark> : <span key={index}>{piece.text}</span>,
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <p className="search:m-0 search:text-text-muted" role="status" aria-live="polite">
        {trimmed === ""
          ? ""
          : state.running
            ? "Searching"
            : `${state.hits.length} result${state.hits.length === 1 ? "" : "s"} for ${trimmed}`}
      </p>
    </section>
  );
}
