/**
 * The full results page (`#/search?q=…`).
 *
 * Results are grouped by nothing by default — one merged, ranked list is what a person
 * wants — but every row says which provider(s) found it, and a per-provider strip above
 * the list reports counts and failures. That is the honest presentation of a provider
 * registry: "the server index is unreachable" is information, and an offline client
 * whose only working provider is the local index should be able to see that it still
 * has complete local coverage (SPEC §4.1).
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
  readonly onOpenDocument: (id: string) => void;
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

  // The URL is the source of truth: a back/forward navigation or a link from the box
  // must move the page, not be overwritten by stale local state.
  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const state = useSearch(engine, query, { limit: 100 });
  const failures = useProviderErrors(state);
  const trimmed = query.trim();

  return (
    <section className="search-results" aria-labelledby="search-results-heading">
      <h2 id="search-results-heading">Search</h2>

      <form
        className="search-form"
        onSubmit={(event) => {
          event.preventDefault();
          onQueryChange(query);
        }}
      >
        <label className="search-field">
          <span className="search-visually-hidden">Search documents</span>
          <input
            type="search"
            value={query}
            autoFocus
            spellCheck={false}
            placeholder="Search every document…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button type="submit">Search</button>
      </form>

      <ul className="search-providers" aria-label="Providers">
        {state.results.map((result) => (
          <li key={result.providerId} className={result.error ? "search-provider-failed" : undefined}>
            {result.label}:{" "}
            {result.error ? (
              <span className="search-provider-error">unavailable — {result.error}</span>
            ) : (
              `${result.hits.length} hit${result.hits.length === 1 ? "" : "s"}`
            )}
          </li>
        ))}
      </ul>

      {failures.length > 0 && (
        <p className="search-note" role="status">
          Some providers need a network connection. Results below come from the ones that
          answered — the local index covers every document on this device, online or off.
        </p>
      )}

      {trimmed === "" ? (
        <p className="search-empty">
          Type to search titles, text and frontmatter. Search runs on this device, so it
          works offline.
        </p>
      ) : state.running ? (
        <p className="search-empty" role="status">
          Searching…
        </p>
      ) : state.hits.length === 0 ? (
        <p className="search-empty">
          Nothing matches “{trimmed}”.
          {documentCount !== undefined && documentCount > 0 && (
            <>
              {" "}
              If this workspace was just opened on this device, the local index may still
              be building — it indexes in the background and this page updates when it
              finishes.
            </>
          )}
        </p>
      ) : (
        <ol className="search-list">
          {state.hits.map((hit) => {
            const row = state.rows.get(hit.id);
            const snippet = snippetFor(row?.content, hit.terms);
            return (
              <li key={hit.id} className="search-result">
                <button
                  type="button"
                  className="search-result-open"
                  onClick={() => onOpenDocument(hit.id)}
                >
                  {row?.title ?? hit.id}
                </button>
                <p className="search-result-meta">
                  {typeof row?.fm["path"] === "string" && row.fm["path"] !== "" && (
                    <span className="search-result-path">{String(row.fm["path"])}</span>
                  )}
                  <span className="search-result-providers">{hit.providers.join(", ")}</span>
                </p>
                {snippet && (
                  <p className="search-result-snippet">
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

      <p className="search-status" role="status" aria-live="polite">
        {trimmed === ""
          ? ""
          : state.running
            ? "Searching"
            : `${state.hits.length} result${state.hits.length === 1 ? "" : "s"} for ${trimmed}`}
      </p>
    </section>
  );
}
