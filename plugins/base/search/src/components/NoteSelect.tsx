/**
 * `NoteSelect` — picking one note: a text box, and under it every note, last updated
 * first, narrowed by what is typed. The value is the chosen note's id.
 *
 * Each note is drawn as the folder tree draws it — its colour and icon (`setNoteLooks`,
 * which `folders` calls), its title, the notes above it — in a virtual list
 * (`_shared/virtual-list.ts`), so a workspace of thousands costs a screenful. The notes are
 * one live query, held only while the list is open.
 *
 * Arrow keys move through the list, Enter picks, Escape closes it. Unfocused, the box
 * shows the chosen note's title; focused, it is the text. With `emptyLabel`, "no note" is
 * a choice too: first in the list, and chosen as `""`.
 */

import { useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ComponentType, ReactElement } from "react";

import type { DocumentQuery, DocumentsApi, Unsubscribe } from "@kernel";
import type { WorkspaceIndex } from "plugin:indexer";
import type { NoteSelectProps } from "../api.js";

import { withoutMachineDocuments } from "../../../_shared/machine-docs.js";
import { NoteName, type NoteLook } from "../../../_shared/note-picker.js";
import { useLiveQuery } from "../../../_shared/useLiveQuery.js";
import { useVirtualList } from "../../../_shared/virtual-list.js";

/** How notes are dressed: `folders`' `look` and `onLookChange`. */
export interface NoteLooks {
  readonly look: (id: string) => NoteLook | undefined;
  readonly onLookChange: (listener: () => void) => Unsubscribe;
}

export interface NoteSelectDeps {
  readonly documents: DocumentsApi;
  /** Where each note sits in the tree. */
  readonly index: Pick<WorkspaceIndex, "documents" | "subscribe" | "version">;
  /** The looks in force, when a plugin has set them. */
  readonly looks: () => NoteLooks | undefined;
  /** Fires when `looks` is set or cleared. */
  readonly onLooksSet: (listener: () => void) => Unsubscribe;
}

interface Option {
  readonly id: string;
  readonly title: string;
  readonly folder: string;
}

const EVERY_NOTE: DocumentQuery = {
  filter: withoutMachineDocuments(),
  sort: [{ field: "updated_at", direction: "desc" }],
};

/** A row, before it is measured: the tap target. */
const ROW_ESTIMATE = 44;

const MUTED: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "0.85em",
  color: "var(--lm-text-muted)",
};

export function createNoteSelect({ documents, index, looks, onLooksSet }: NoteSelectDeps): ComponentType<NoteSelectProps> {
  /** The chosen note's title, kept up to date as the id changes. */
  function useTitle(id: string | undefined): string {
    const [title, setTitle] = useState("");
    useEffect(() => {
      if (id === undefined || id === "") {
        setTitle("");
        return undefined;
      }
      let live = true;
      void documents.get(id).then((row) => {
        // Deleted, or not on this device yet: say so, not the id.
        if (live) setTitle(row === undefined ? "Unknown note" : row.title || "Untitled");
      });
      return () => {
        live = false;
      };
    }, [id]);
    return title;
  }

  /** Each note's place in the tree, by id; live with the index. */
  function useFolders(): ReadonlyMap<string, string> {
    const version = useSyncExternalStore(index.subscribe, () => index.version);
    // `version` is the dependency that says `documents()` moved.
    return useMemo(() => new Map(index.documents().map((note) => [note.id, note.folder])), [version]);
  }

  /** The looks in force; re-renders when they are set, or any note's look changes. */
  function useLooks(): NoteLooks | undefined {
    const [, bump] = useState(0);
    useEffect(() => onLooksSet(() => bump((count) => count + 1)), []);
    const current = looks();
    useEffect(() => current?.onLookChange(() => bump((count) => count + 1)), [current]);
    return current;
  }

  /** The open list: every note, last updated first, narrowed by `query`. */
  function OptionList({
    id,
    query,
    emptyLabel,
    active,
    setActive,
    choose,
    label,
    onOptions,
    scrollTo,
  }: {
    readonly id: string;
    readonly query: string;
    readonly emptyLabel: string | undefined;
    readonly active: number;
    readonly setActive: (index: number) => void;
    readonly choose: (id: string) => void;
    readonly label: string;
    readonly onOptions: (options: readonly Option[]) => void;
    readonly scrollTo: { current: ((index: number) => void) | undefined };
  }): ReactElement {
    const live = useLiveQuery(documents, EVERY_NOTE);
    const folders = useFolders();
    const dressed = useLooks();

    const options = useMemo(() => {
      const needle = query.trim().toLowerCase();
      const all: Option[] = live.rows.map((row) => ({ id: row.id, title: row.title, folder: folders.get(row.id) ?? "" }));
      const matching =
        needle === ""
          ? all
          : all.filter((note) => note.title.toLowerCase().includes(needle) || note.folder.toLowerCase().includes(needle));
      return emptyLabel !== undefined && needle === "" ? [{ id: "", title: emptyLabel, folder: "" }, ...matching] : matching;
    }, [live.rows, folders, query, emptyLabel]);
    useEffect(() => onOptions(options), [options]);

    const virtual = useVirtualList({
      count: options.length,
      keyOf: (at) => options[at]?.id ?? String(at),
      estimate: ROW_ESTIMATE,
      clipToWindow: false,
    });
    scrollTo.current = virtual.scrollToIndex;

    return (
      <div className="search:absolute search:inset-x-0 search:top-full search:z-20 search:mt-1 search:max-h-64 search:overflow-y-auto search:overscroll-contain search:rounded search:border search:border-border search:bg-bg-raised search:p-1 search:shadow-2">
        {options.length === 0 ? (
          <p className="search:m-0 search:px-2 search:py-1.5 search:text-sm search:text-text-muted">
            {live.loading ? "Loading…" : "No note matches."}
          </p>
        ) : (
          <ul
            ref={virtual.listRef}
            id={id}
            role="listbox"
            aria-label={label}
            className="search:m-0 search:list-none search:p-0"
            style={{ paddingTop: virtual.before, paddingBottom: virtual.after }}
          >
            {options.slice(virtual.first, virtual.end).map((note, offset) => {
              const at = virtual.first + offset;
              return (
                <li
                  key={note.id}
                  id={`${id}-${at}`}
                  data-virtual-index={at}
                  role="option"
                  aria-selected={at === active}
                  className="search:tap-h search:flex search:min-w-0 search:cursor-pointer search:items-center search:gap-2 search:rounded search:px-2 search:aria-selected:bg-accent-subtle"
                  // Before the input's blur closes the list.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(at)}
                  onClick={() => choose(note.id)}
                >
                  {note.id === "" ? (
                    <span className="search:text-text-muted">{note.title}</span>
                  ) : (
                    <NoteName title={note.title} look={dressed?.look(note.id)} />
                  )}
                  {note.folder !== "" && <span style={MUTED}>{note.folder}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  return function NoteSelect({
    value,
    onChange,
    placeholder = "Find a note",
    label = "Note",
    autoFocus = false,
    emptyLabel,
  }: NoteSelectProps): ReactElement {
    const listId = useId();
    const title = useTitle(value);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    const [options, setOptions] = useState<readonly Option[]>([]);
    const [scrollTo] = useState<{ current: ((index: number) => void) | undefined }>(() => ({ current: undefined }));
    const shown = value === "" && emptyLabel !== undefined ? emptyLabel : title;

    const choose = (id: string): void => {
      onChange(id);
      setOpen(false);
      setQuery("");
    };

    const close = (): void => {
      setOpen(false);
      setQuery("");
    };

    const move = (to: number): void => {
      const next = Math.max(0, Math.min(to, options.length - 1));
      setActive(next);
      scrollTo.current?.(next);
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
          {...(open && options[active] ? { "aria-activedescendant": `${listId}-${active}` } : {})}
          placeholder={placeholder}
          value={open ? query : shown}
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
            scrollTo.current?.(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              move(active + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(active - 1);
            } else if (event.key === "Enter") {
              const option = options[active];
              if (open && option) {
                event.preventDefault();
                choose(option.id);
              }
            } else if (event.key === "Escape" && open) {
              event.preventDefault();
              close();
              event.currentTarget.blur();
            }
          }}
        />
        {open && (
          <OptionList
            id={listId}
            query={query}
            emptyLabel={emptyLabel}
            active={active}
            setActive={setActive}
            choose={choose}
            label={label}
            onOptions={setOptions}
            scrollTo={scrollTo}
          />
        )}
      </div>
    );
  };
}
