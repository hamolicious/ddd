import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ComponentType, KeyboardEvent, ReactElement, RefObject } from "react";

import type { Unsubscribe } from "@kernel";
import type { SearchSnippet, SearchViewProps } from "plugin:search";

import { splitHighlights } from "../../_shared/highlights.js";
import { LoadMore } from "../../_shared/LoadMore.js";
import { NoteName, type NoteLook } from "../../_shared/note-picker.js";
import { target as mark } from "../../_shared/target.js";

export interface NoteListProps extends Pick<SearchViewProps, "results" | "onOpen"> {
  readonly searchInput?: RefObject<HTMLInputElement>;
}

export interface FolderIndex {
  readonly documents: () => readonly { readonly id: string; readonly folder: string }[];
  readonly subscribe: (listener: () => void) => Unsubscribe;
  readonly version: () => number;
}

export interface Looks {
  readonly look: (id: string) => NoteLook | undefined;
  readonly onLookChange: (listener: () => void) => Unsubscribe;
}

export interface NoteListDeps {
  readonly useLooks: () => Looks | undefined;
  readonly folders: FolderIndex;
  readonly openMenu: (element: HTMLElement) => void;
}

const OPEN = ".doclist-note-open";

export function moveFocus(buttons: readonly HTMLElement[], from: number, key: string): number | "input" | undefined {
  if (buttons.length === 0) return undefined;
  switch (key) {
    case "ArrowDown":
      return Math.min(buttons.length - 1, from + 1);
    case "ArrowUp":
      return from <= 0 ? "input" : from - 1;
    case "Home":
      return 0;
    case "End":
      return buttons.length - 1;
    case "Escape":
      return "input";
    default:
      return undefined;
  }
}

function Match({ snippet }: { readonly snippet: SearchSnippet }): ReactElement {
  return (
    <p className="doclist-note-match doclist:m-0 doclist:line-clamp-2 doclist:min-w-0 doclist:break-words doclist:text-sm doclist:text-text-muted doclist:[&_mark]:bg-selection doclist:[&_mark]:text-inherit">
      {splitHighlights(snippet).map((piece, index) =>
        piece.hit ? <mark key={index}>{piece.text}</mark> : <span key={index}>{piece.text}</span>,
      )}
    </p>
  );
}

export function createNoteList({ useLooks, folders, openMenu }: NoteListDeps): ComponentType<NoteListProps> {
  return function NoteList({ results, onOpen, searchInput }: NoteListProps): ReactElement {
    const looks = useLooks();
    const [, bump] = useState(0);
    useEffect(() => looks?.onLookChange(() => bump((count) => count + 1)), [looks]);
    const version = useSyncExternalStore(folders.subscribe, folders.version);
    const folderOf = useMemo(() => new Map(folders.documents().map((note) => [note.id, note.folder])), [version]);
    const list = useRef<HTMLUListElement>(null);
    const ids = useId();

    const buttons = (): HTMLElement[] => [...(list.current?.querySelectorAll<HTMLElement>(OPEN) ?? [])];

    useEffect(() => {
      const input = searchInput?.current;
      if (!input) return;
      const enter = (event: globalThis.KeyboardEvent): void => {
        if (event.key !== "ArrowDown") return;
        const first = buttons()[0];
        if (!first) return;
        event.preventDefault();
        first.focus();
      };
      input.addEventListener("keydown", enter);
      return () => input.removeEventListener("keydown", enter);
    });

    const onKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
      const all = buttons();
      const from = all.indexOf(document.activeElement as HTMLElement);
      if (from === -1) return;
      const next = moveFocus(all, from, event.key);
      if (next === undefined) return;
      if (next === "input") {
        if (!searchInput?.current) return;
        event.preventDefault();
        searchInput.current.focus();
        return;
      }
      event.preventDefault();
      all[next]?.focus();
    };

    return (
      <>
        <ul
          ref={list}
          className="doclist-notes doclist:m-0 doclist:flex doclist:list-none doclist:flex-col doclist:gap-0.5 doclist:p-0"
          aria-label="Notes"
          onKeyDown={onKeyDown}
        >
          {results.rows.map((row) => {
            const look = looks?.look(row.id);
            const folder = folderOf.get(row.id) ?? "";
            const snippet = results.snippetOf(row);
            const titleId = `${ids}-${row.id}`;
            return (
              <li
                key={row.id}
                className="doclist-note doclist:flex doclist:min-w-0 doclist:items-start doclist:gap-1"
                {...mark("ddd/document", row.id, { label: row.title })}
              >
                <button
                  type="button"
                  className="doclist-note-open doclist:flex doclist:min-w-0 doclist:flex-1 doclist:flex-col doclist:items-stretch doclist:gap-0.5 doclist:rounded doclist:border-transparent! doclist:bg-transparent! doclist:px-2! doclist:py-1.5 doclist:text-left doclist:hover:bg-bg-subtle! doclist:focus-visible:bg-bg-subtle!"
                  aria-labelledby={titleId}
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.setData("text/plain", row.id);
                    event.dataTransfer.effectAllowed = "move";
                  }}
                  onClick={() => onOpen(row.id, snippet?.line)}
                >
                  <span className="doclist:flex doclist:min-w-0 doclist:items-baseline doclist:gap-2">
                    <span id={titleId} className="doclist-note-title doclist:min-w-0 doclist:font-medium doclist:text-link">
                      <NoteName title={row.title} look={look} />
                    </span>
                    {folder !== "" && (
                      <span className="doclist-note-folder doclist:min-w-0 doclist:truncate doclist:text-sm doclist:text-text-muted">{folder}</span>
                    )}
                  </span>
                  {snippet && <Match snippet={snippet} />}
                </button>
                <button
                  type="button"
                  className="doclist-note-menu doclist:inline-flex doclist:w-[var(--ddd-tap-target)] doclist:shrink-0 doclist:items-center doclist:justify-center doclist:border-transparent! doclist:bg-transparent! doclist:p-0! doclist:text-text-muted doclist:hover:border-border! doclist:hover:text-text"
                  aria-haspopup="menu"
                  aria-label={`Actions for ${row.title}`}
                  tabIndex={-1}
                  onClick={(event) => openMenu(event.currentTarget)}
                >
                  ⋯
                </button>
              </li>
            );
          })}
        </ul>
        {results.hasMore && <LoadMore busy={results.loading} onMore={results.more} />}
      </>
    );
  };
}
