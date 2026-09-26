/**
 * The navbar search box: type, see the first few hits, Enter for the full results page.
 *
 * It is a `combobox`/`listbox` pair with `aria-activedescendant`, the same pattern the
 * command palette uses, because the interaction is the same one and a second pattern
 * would mean a second set of keyboard bugs. `ArrowDown`/`ArrowUp` move, `Enter` opens
 * the active hit (or the results page when nothing is active), `Escape` closes the
 * dropdown and keeps the text.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";

import { snippetFor, splitHighlights } from "./merge.js";
import { useSearch, type SearchEngine } from "./useSearch.js";

export interface SearchBoxProps {
  readonly engine: SearchEngine;
  /** Open a document (the router's job; passed in so this file has no URL knowledge). */
  readonly onOpenDocument: (id: string) => void;
  /** Open the full results page for `query`. */
  readonly onOpenResults: (query: string) => void;
  /** How many hits fit in the dropdown. */
  readonly previewLimit?: number;
}

export function SearchBox({
  engine,
  onOpenDocument,
  onOpenResults,
  previewLimit = 8,
}: SearchBoxProps): ReactElement {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();

  const state = useSearch(engine, query, { limit: previewLimit, enabled: open });
  const hits = state.hits;
  const clamped = hits.length === 0 ? -1 : Math.min(active, hits.length - 1);

  useEffect(() => {
    setActive(-1);
  }, [state.settled]);

  // A click elsewhere closes the dropdown; the text stays, so re-focusing resumes.
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  const openResults = useCallback(() => {
    setOpen(false);
    onOpenResults(query);
  }, [onOpenResults, query]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          setOpen(true);
          setActive((current) => (hits.length === 0 ? -1 : (current + 1) % hits.length));
          return;
        case "ArrowUp":
          event.preventDefault();
          setActive((current) => (hits.length === 0 ? -1 : (current - 1 + hits.length) % hits.length));
          return;
        case "Escape":
          event.preventDefault();
          setOpen(false);
          return;
        case "Enter": {
          event.preventDefault();
          const hit = clamped >= 0 ? hits[clamped] : undefined;
          if (hit) {
            setOpen(false);
            onOpenDocument(hit.id);
            return;
          }
          openResults();
          return;
        }
        default:
      }
    },
    [clamped, hits, onOpenDocument, openResults],
  );

  const listboxId = `${baseId}-hits`;
  const activeId = clamped >= 0 ? `${baseId}-hit-${clamped}` : undefined;
  const showDropdown = open && query.trim() !== "";

  return (
    <div className="search-box search:relative search:max-w-md search:flex-[1_1_18rem] search:font-sans search:compact:min-w-0 search:compact:w-full search:compact:max-w-none search:compact:flex-none!" ref={rootRef} onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="search:tap-h search:w-full search:rounded search:border search:border-border search:bg-bg search:px-2 search:text-text search:focus-visible:outline-2 search:focus-visible:outline-offset-1 search:focus-visible:outline-focus"
        type="search"
        role="combobox"
        aria-expanded={showDropdown}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-label="Search documents"
        {...(activeId ? { "aria-activedescendant": activeId } : {})}
        placeholder="Search…"
        value={query}
        spellCheck={false}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
      />

      {showDropdown && (
        <div className="search-dropdown search:absolute search:inset-x-0 search:top-[calc(100%+4px)] search:z-[900] search:max-h-[min(60vh,28rem)] search:overflow-y-auto search:rounded search:border search:border-border search:bg-bg-raised search:text-text search:shadow-2 search:compact:fixed search:compact:inset-x-2 search:compact:top-auto search:compact:mt-1 search:compact:max-h-[min(50dvh,22rem)]">
          <ul className="search:m-0 search:list-none search:p-0" id={listboxId} role="listbox" aria-label="Search results">
            {hits.map((hit, index) => {
              const row = state.rows.get(hit.id);
              const snippet = snippetFor(row?.content, hit.terms, { maxLength: 110 });
              return (
                <li
                  key={hit.id}
                  id={`${baseId}-hit-${index}`}
                  role="option"
                  aria-selected={index === clamped}
                  className={`search-hit search:block search:min-w-0 search:cursor-pointer search:px-2 search:py-1.5 ${index === clamped ? " search-hit-active search:bg-accent-subtle" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setOpen(false);
                    onOpenDocument(hit.id);
                  }}
                >
                  <span className="search:block search:truncate">{row?.title ?? hit.id}</span>
                  {snippet && (
                    <span className="search-hit-snippet search:line-clamp-2 search:break-words search:text-[0.88em] search:text-text-muted search:[&_mark]:bg-selection search:[&_mark]:text-inherit">
                      {splitHighlights(snippet).map((piece, pieceIndex) =>
                        piece.hit ? (
                          <mark key={pieceIndex}>{piece.text}</mark>
                        ) : (
                          <span key={pieceIndex}>{piece.text}</span>
                        ),
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {hits.length === 0 && (
            <p className="search:m-0 search:px-4 search:py-2 search:text-text-muted">
              {state.running ? "Searching…" : `Nothing matches “${query.trim()}”.`}
            </p>
          )}

          <button type="button" className="search:tap-h search:w-full search:cursor-pointer search:border-0 search:border-t search:border-border search:bg-bg-subtle search:text-link" onMouseDown={(event) => {
            event.preventDefault();
            openResults();
          }}>
            See all results
          </button>
          <p className="search:m-0 search:px-4 search:py-2 search:text-text-muted" role="status" aria-live="polite">
            {state.running ? "Searching" : `${hits.length} result${hits.length === 1 ? "" : "s"}`}
          </p>
        </div>
      )}
    </div>
  );
}
