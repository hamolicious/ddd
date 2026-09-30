/**
 * `NoteSelect` — picking one note: a text box that searches as you type, and a list of
 * matches under it. The value is the chosen note's id.
 *
 * It is a search like any other (`useResults`, no filter): with no text the list is the
 * notes last updated, with text it is the providers' best matches. Arrow keys move through
 * the list, Enter picks, Escape closes it.
 *
 * Unfocused, the box shows the chosen note's title; focused, it is the search text.
 */

import { useEffect, useId, useState } from "react";
import type { ComponentType, ReactElement } from "react";

import type { DocumentsApi } from "@kernel";
import type { NoteSelectProps } from "../api.js";

import { useResults } from "../results.js";
import { EMPTY_SPEC } from "../spec.js";
import type { SearchEngine } from "../useSearch.js";

export interface NoteSelectDeps {
  readonly documents: DocumentsApi;
  readonly engine: SearchEngine;
}

const PAGE_SIZE = 8;

export function createNoteSelect({ documents, engine }: NoteSelectDeps): ComponentType<NoteSelectProps> {
  /** The chosen note's title, kept up to date as the id changes. */
  function useTitle(id: string | undefined): string {
    const [title, setTitle] = useState("");
    useEffect(() => {
      if (id === undefined) {
        setTitle("");
        return undefined;
      }
      let live = true;
      void documents.get(id).then((row) => {
        if (live) setTitle(row?.title || "Untitled");
      });
      return () => {
        live = false;
      };
    }, [id]);
    return title;
  }

  return function NoteSelect({
    value,
    onChange,
    placeholder = "Find a note",
    label = "Note",
    autoFocus = false,
  }: NoteSelectProps): ReactElement {
    const listId = useId();
    const title = useTitle(value);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);

    const results = useResults(documents, engine, { ...EMPTY_SPEC, query }, { pageSize: PAGE_SIZE });
    const rows = open ? results.rows.slice(0, PAGE_SIZE) : [];

    const choose = (id: string): void => {
      onChange(id);
      setOpen(false);
      setQuery("");
    };

    const close = (): void => {
      setOpen(false);
      setQuery("");
    };

    return (
      <div className="search-note-select search:relative search:min-w-0">
        <input
          type="text"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          {...(open && rows[active] ? { "aria-activedescendant": `${listId}-${active}` } : {})}
          placeholder={placeholder}
          value={open ? query : title}
          spellCheck={false}
          autoComplete="off"
          autoFocus={autoFocus}
          className="search:tap-h search:w-full search:min-w-0 search:rounded search:border search:border-border search:bg-bg search:px-2 search:text-base search:text-text"
          onFocus={() => {
            setOpen(true);
            setActive(0);
          }}
          onBlur={close}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActive((index) => Math.min(index + 1, Math.max(rows.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter") {
              const row = rows[active];
              if (row) {
                event.preventDefault();
                choose(row.id);
              }
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              close();
              event.currentTarget.blur();
            }
          }}
        />
        {open && (
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            className="search:absolute search:inset-x-0 search:top-full search:z-20 search:m-0 search:mt-1 search:max-h-64 search:list-none search:overflow-y-auto search:overscroll-contain search:rounded search:border search:border-border search:bg-bg-raised search:p-1 search:shadow-2"
          >
            {rows.length === 0 ? (
              <li className="search:px-2 search:py-1.5 search:text-sm search:text-text-muted">
                {results.loading ? "Searching…" : "No note matches."}
              </li>
            ) : (
              rows.map((row, index) => (
                <li
                  key={row.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className="search:tap-h search:flex search:cursor-pointer search:items-center search:rounded search:px-2 search:aria-selected:bg-accent-subtle search:aria-selected:text-accent"
                  // Before the input's blur closes the list.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(row.id)}
                >
                  <span className="search:truncate">{row.title || "Untitled"}</span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    );
  };
}
