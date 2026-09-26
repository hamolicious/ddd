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
    <div className="search-box relative max-w-md flex-[1_1_18rem] font-sans compact:min-w-0 compact:w-full compact:max-w-none compact:flex-none!" ref={rootRef} onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className="tap-h w-full rounded border border-border bg-bg px-2 text-text focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus"
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
        <div className="search-dropdown absolute inset-x-0 top-[calc(100%+4px)] z-[900] max-h-[min(60vh,28rem)] overflow-y-auto rounded border border-border bg-bg-raised text-text shadow-2 compact:fixed compact:inset-x-2 compact:top-auto compact:mt-1 compact:max-h-[min(50dvh,22rem)]">
          <ul className="m-0 list-none p-0" id={listboxId} role="listbox" aria-label="Search results">
            {hits.map((hit, index) => {
              const row = state.rows.get(hit.id);
              const snippet = snippetFor(row?.content, hit.terms, { maxLength: 110 });
              return (
                <li
                  key={hit.id}
                  id={`${baseId}-hit-${index}`}
                  role="option"
                  aria-selected={index === clamped}
                  className={`search-hit block min-w-0 cursor-pointer px-2 py-1.5 ${index === clamped ? " search-hit-active bg-accent-subtle" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setOpen(false);
                    onOpenDocument(hit.id);
                  }}
                >
                  <span className="block truncate">{row?.title ?? hit.id}</span>
                  {snippet && (
                    <span className="search-hit-snippet line-clamp-2 break-words text-[0.88em] text-text-muted [&_mark]:bg-selection [&_mark]:text-inherit">
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
            <p className="m-0 px-4 py-2 text-text-muted">
              {state.running ? "Searching…" : `Nothing matches “${query.trim()}”.`}
            </p>
          )}

          <button type="button" className="tap-h w-full cursor-pointer border-0 border-t border-border bg-bg-subtle text-link" onMouseDown={(event) => {
            event.preventDefault();
            openResults();
          }}>
            See all results
          </button>
          <p className="m-0 px-4 py-2 text-text-muted" role="status" aria-live="polite">
            {state.running ? "Searching" : `${hits.length} result${hits.length === 1 ? "" : "s"}`}
          </p>
        </div>
      )}
    </div>
  );
}
