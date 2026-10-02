import { useEffect, useMemo, useState } from "react";
import type { ComponentType, ReactElement } from "react";

import type { DocumentQuery, DocumentsApi } from "@kernel";
import type { NoteSelectProps } from "../api.js";

import { withoutMachineDocuments } from "../../../_shared/machine-docs.js";
import { useLiveQuery } from "../../../_shared/useLiveQuery.js";

import { Combobox, type ComboboxOptions } from "./Combobox.js";
import { NoteRow, type NoteHooks } from "./notes.js";
import { byProximity } from "./proximity.js";

export type { NoteLooks } from "./notes.js";

export interface NoteSelectDeps {
  readonly documents: DocumentsApi;
  readonly notes: NoteHooks;
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

export function createNoteSelect({ documents, notes }: NoteSelectDeps): ComponentType<NoteSelectProps> {
  function useTitle(id: string | undefined): string {
    const [title, setTitle] = useState("");
    useEffect(() => {
      if (id === undefined || id === "") {
        setTitle("");
        return undefined;
      }
      let live = true;
      void documents.get(id).then((row) => {
        if (live) setTitle(row === undefined ? "Unknown note" : row.title || "Untitled");
      });
      return () => {
        live = false;
      };
    }, [id]);
    return title;
  }

  function useNoteOptions(
    query: string,
    cwd: string | undefined,
    emptyLabel: string | undefined,
    exclude: ((id: string) => boolean) | undefined,
  ): ComboboxOptions<Option> {
    const live = useLiveQuery(documents, EVERY_NOTE);
    const known = notes.useKnownNotes();
    const { current: dressed, version } = notes.useLooks();
    const options = useMemo(() => {
      const needle = query.trim().toLowerCase();
      const all: Option[] = live.rows
        .filter((row) => exclude === undefined || !exclude(row.id))
        .map((row) => ({ id: row.id, title: row.title, folder: known.get(row.id)?.folder ?? "" }));
      const matching =
        needle === ""
          ? all
          : all.filter((note) => note.title.toLowerCase().includes(needle) || note.folder.toLowerCase().includes(needle));
      const parentOf = dressed?.parentOf;
      const sorted = cwd !== undefined && parentOf !== undefined ? byProximity(matching, parentOf, cwd) : matching;
      return emptyLabel !== undefined && needle === "" ? [{ id: "", title: emptyLabel, folder: "" }, ...sorted] : sorted;
    }, [live.rows, known, query, cwd, emptyLabel, exclude, dressed, version]);
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
    exclude,
    inline = false,
  }: NoteSelectProps): ReactElement {
    const title = useTitle(value);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const shown = value === "" && emptyLabel !== undefined ? emptyLabel : title;

    return (
      <Combobox<Option>
        label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        text={open || inline ? query : shown}
        inline={inline}
        onText={setQuery}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery("");
        }}
        useOptions={() => useNoteOptions(query, cwd, emptyLabel, exclude)}
        keyOf={(note) => note.id}
        renderOption={(note) => (
          note.id === "" ? (
            <span className="search:text-text-muted">{note.title}</span>
          ) : (
            <NoteRow title={note.title} folder={note.folder} look={notes.look(note.id)} />
          )
        )}
        onPick={(note) => onChange(note.id)}
        empty="No note matches."
      />
    );
  };
}
