/**
 * `NoteSelect` — picking one note: a text box, and under it every note, last updated
 * first, narrowed by what is typed. The value is the chosen note's id.
 *
 * Each note is drawn as the folder tree draws it — its colour and icon (`setNoteLooks`,
 * which `folders` calls), its title, the notes above it — in `Combobox`'s virtual list. The
 * notes are one live query, held only while the list is open.
 *
 * With `cwd`, the notes nearest it in the tree come first (`proximity.ts`), last updated
 * first among equals. That needs the tree, from `folders` as well; without it, `cwd` is
 * ignored.
 *
 * Unfocused, the box shows the chosen note's title; focused, it is the text. With
 * `emptyLabel`, "no note" is a choice too: first in the list, and chosen as `""`.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { CSSProperties, ComponentType, ReactElement } from "react";

import type { DocumentQuery, DocumentsApi, Unsubscribe } from "@kernel";
import type { WorkspaceIndex } from "plugin:indexer";
import type { NoteSelectProps } from "../api.js";

import { withoutMachineDocuments } from "../../../_shared/machine-docs.js";
import { NoteName, type NoteLook } from "../../../_shared/note-picker.js";
import { useLiveQuery } from "../../../_shared/useLiveQuery.js";

import { Combobox, type ComboboxOptions } from "./Combobox.js";
import { byProximity, type ParentOf } from "./proximity.js";

/** How notes are dressed, and where they sit: `folders`' functions of the same names. */
export interface NoteLooks {
  readonly look: (id: string) => NoteLook | undefined;
  readonly onLookChange: (listener: () => void) => Unsubscribe;
  /** The note's parent, `""` at the root; for `cwd`. Since 4.6.0. */
  readonly parentOf?: ParentOf;
  /** Fires when the tree changes. Since 4.6.0. */
  readonly onChange?: (listener: () => void) => Unsubscribe;
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

  /** The looks in force; re-renders when they are set, or any note's look or place changes. */
  function useLooks(): { readonly current: NoteLooks | undefined; readonly version: number } {
    const [version, bump] = useState(0);
    useEffect(() => onLooksSet(() => bump((count) => count + 1)), []);
    const current = looks();
    useEffect(() => {
      const again = (): void => bump((count) => count + 1);
      const offLook = current?.onLookChange(again);
      const offTree = current?.onChange?.(again);
      return () => {
        offLook?.();
        offTree?.();
      };
    }, [current]);
    return { current, version };
  }

  /** Every note, last updated first (nearest `cwd` first, with it), narrowed by `query`. */
  function useNoteOptions(query: string, cwd: string | undefined, emptyLabel: string | undefined): ComboboxOptions<Option> {
    const live = useLiveQuery(documents, EVERY_NOTE);
    const folders = useFolders();
    const { current: dressed, version } = useLooks();
    const options = useMemo(() => {
      const needle = query.trim().toLowerCase();
      const all: Option[] = live.rows.map((row) => ({ id: row.id, title: row.title, folder: folders.get(row.id) ?? "" }));
      const matching =
        needle === ""
          ? all
          : all.filter((note) => note.title.toLowerCase().includes(needle) || note.folder.toLowerCase().includes(needle));
      const parentOf = dressed?.parentOf;
      // The live query is last updated first, and ties keep that order.
      const sorted = cwd !== undefined && parentOf !== undefined ? byProximity(matching, parentOf, cwd) : matching;
      return emptyLabel !== undefined && needle === "" ? [{ id: "", title: emptyLabel, folder: "" }, ...sorted] : sorted;
    }, [live.rows, folders, query, cwd, emptyLabel, dressed, version]);
    return { options, loading: live.loading };
  }

  return function NoteSelect({
    value,
    onChange,
    placeholder = "Find a note",
    label = "Note",
    autoFocus = false,
    emptyLabel,
    cwd,
  }: NoteSelectProps): ReactElement {
    const title = useTitle(value);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const shown = value === "" && emptyLabel !== undefined ? emptyLabel : title;
    // Drawn only in the open list, where `useNoteOptions` has subscribed to the looks.
    const look = (id: string): NoteLook | undefined => looks()?.look(id);

    return (
      <Combobox<Option>
        label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        text={open ? query : shown}
        onText={setQuery}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        useOptions={() => useNoteOptions(query, cwd, emptyLabel)}
        keyOf={(note) => note.id}
        renderOption={(note) => (
          <>
            {note.id === "" ? (
              <span className="search:text-text-muted">{note.title}</span>
            ) : (
              <NoteName title={note.title} look={look(note.id)} />
            )}
            {note.folder !== "" && <span style={MUTED}>{note.folder}</span>}
          </>
        )}
        onPick={(note) => onChange(note.id)}
        empty="No note matches."
      />
    );
  };
}
