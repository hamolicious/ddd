/**
 * `FmKeySelect` and `FmValueSelect` — a frontmatter key, and a value of one, typed or
 * picked from what the workspace holds (`plugin:indexer`): the keys in use, most-used
 * first, and the values a key holds, commonest first, each with how many notes have it.
 *
 * The text is the value: typing a key or a value nobody has used yet is fine, and every
 * keystroke is an `onChange`. The list only suggests. Keys only machines write, and keys
 * holding maps, are not suggested.
 *
 * `FmValueSelect` with `multiple` is a comma-separated list ("work, home"): the list
 * suggests for the last item, and picking replaces it.
 *
 * A value that links a note (`doc://<id>`) is drawn as the note, as the folder tree draws
 * it, and found by its title or the notes above it too. Closed, the box shows a linked
 * note's title rather than the link.
 */

import { useMemo, useState, useSyncExternalStore } from "react";
import type { ComponentType, ReactElement } from "react";

import type { FmField, PropertyKind, WorkspaceIndex } from "plugin:indexer";
import type { FmKeySelectProps, FmValueSelectProps } from "../api.js";

import { DOC_PREFIX } from "../../../_shared/conditions.js";

import { Combobox, type ComboboxOptions } from "./Combobox.js";
import { NoteRow, type KnownNote, type NoteHooks } from "./notes.js";

export type FmIndex = Pick<WorkspaceIndex, "fmFields" | "fmValues" | "subscribe" | "version">;

interface Option {
  readonly value: string;
  /** Shown instead of `value`: a built-in field's name. */
  readonly label?: string;
  /** Muted, after it: how many notes, what kind. */
  readonly detail: string;
  /** Notes holding it. */
  readonly count?: number;
  /** The note it links, when it is a `doc://` link. */
  readonly note?: { readonly id: string } & KnownNote;
}

/** The id a `doc://` link names; `undefined` for any other value. */
export function linkedId(value: string): string | undefined {
  return value.startsWith(DOC_PREFIX) && value.length > DOC_PREFIX.length ? value.slice(DOC_PREFIX.length) : undefined;
}

const notesCount = (count: number): string => `${count.toLocaleString()} ${count === 1 ? "note" : "notes"}`;

/** The kind most of a key's values are. */
function commonest(kinds: FmField["kinds"]): PropertyKind | undefined {
  let best: PropertyKind | undefined;
  let most = 0;
  for (const [kind, count] of Object.entries(kinds) as [PropertyKind, number][]) {
    if (count > most) {
      best = kind;
      most = count;
    }
  }
  return best;
}

/** The text after the last comma, and everything up to it (with the space after it). */
export function lastItem(text: string): { readonly before: string; readonly item: string } {
  const comma = text.lastIndexOf(",");
  if (comma === -1) return { before: "", item: text };
  const rest = text.slice(comma + 1);
  const lead = rest.length - rest.trimStart().length;
  return { before: text.slice(0, comma + 1 + lead), item: rest.trimStart() };
}

function Row({ option, notes }: { readonly option: Option; readonly notes: NoteHooks }): ReactElement {
  return (
    <>
      {option.note !== undefined ? (
        <NoteRow title={option.note.title} folder={option.note.folder} look={notes.look(option.note.id)} />
      ) : (
        <span className="search:min-w-0 search:truncate">{option.label ?? option.value}</span>
      )}
      <span className="search:ml-auto search:shrink-0 search:text-sm search:text-text-muted">{option.detail}</span>
    </>
  );
}

export function createFmSelects(
  index: FmIndex,
  notes: NoteHooks,
): {
  readonly FmKeySelect: ComponentType<FmKeySelectProps>;
  readonly FmValueSelect: ComponentType<FmValueSelectProps>;
} {
  const useVersion = (): number => useSyncExternalStore(index.subscribe, () => index.version);

  function useKeyOptions(text: string, builtIn: FmKeySelectProps["builtIn"]): ComboboxOptions<Option> {
    const version = useVersion();
    const options = useMemo(() => {
      const needle = text.trim().toLowerCase();
      const fixed: Option[] = (builtIn ?? []).map((field) => ({ value: field.key, label: field.label, detail: "built in" }));
      const keys: Option[] = index
        .fmFields()
        .filter((field) => !field.machineOnly && commonest(field.kinds) !== "map")
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
        .map((field) => {
          const kind = commonest(field.kinds);
          return { value: field.key, detail: kind === undefined ? notesCount(field.count) : `${kind} · ${notesCount(field.count)}` };
        });
      const all = [...fixed, ...keys];
      return needle === ""
        ? all
        : all.filter((option) => `${option.value} ${option.label ?? ""}`.toLowerCase().includes(needle));
    }, [version, text, builtIn]);
    return { options };
  }

  function useValueOptions(fmKey: string, item: string): ComboboxOptions<Option> {
    const version = useVersion();
    const known = notes.useKnownNotes();
    // Subscribed for the rows' looks.
    notes.useLooks();
    const options = useMemo(() => {
      const key = fmKey.trim();
      if (key === "") return [];
      const needle = item.trim().toLowerCase();
      return index
        .fmValues(key)
        .filter((entry) => entry.value !== null)
        .map((entry): Option => {
          const value = String(entry.value);
          const id = linkedId(value);
          const note = id === undefined ? undefined : known.get(id);
          return {
            value,
            detail: notesCount(entry.count),
            count: entry.count,
            // A link to a note this device does not know stays the link.
            ...(id !== undefined && note !== undefined ? { note: { id, ...note } } : {}),
          };
        })
        .filter(
          (option) =>
            needle === "" ||
            option.value.toLowerCase().includes(needle) ||
            (option.note !== undefined &&
              `${option.note.title} ${option.note.folder}`.toLowerCase().includes(needle)),
        )
        .sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
    }, [version, known, fmKey, item]);
    return { options };
  }

  function FmKeySelect({
    value,
    onChange,
    builtIn,
    placeholder = "Property name",
    label = "Property",
    autoFocus = false,
  }: FmKeySelectProps): ReactElement {
    const [open, setOpen] = useState(false);
    return (
      <Combobox<Option>
        label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        text={value}
        onText={onChange}
        open={open}
        onOpenChange={setOpen}
        useOptions={() => useKeyOptions(value, builtIn)}
        keyOf={(option) => `${option.label === undefined ? "fm" : "built-in"}:${option.value}`}
        renderOption={(option) => <Row option={option} notes={notes} />}
        onPick={(option) => onChange(option.value)}
        empty="No property in use matches."
      />
    );
  }

  function FmValueSelect({
    fmKey,
    value,
    onChange,
    multiple = false,
    placeholder = "Value",
    label = "Value",
    autoFocus = false,
  }: FmValueSelectProps): ReactElement {
    const [open, setOpen] = useState(false);
    const { before, item } = multiple ? lastItem(value) : { before: "", item: value };
    const known = notes.useKnownNotes();
    const id = multiple ? undefined : linkedId(value.trim());
    const shown = id === undefined ? value : (known.get(id)?.title ?? value);
    return (
      <Combobox<Option>
        label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        text={open ? value : shown}
        onText={onChange}
        open={open}
        onOpenChange={setOpen}
        useOptions={() => useValueOptions(fmKey, item)}
        keyOf={(option) => option.value}
        renderOption={(option) => <Row option={option} notes={notes} />}
        onPick={(option) => onChange(`${before}${option.value}`)}
        empty={fmKey.trim() === "" ? "Choose a property first." : "No value in use matches."}
      />
    );
  }

  return { FmKeySelect, FmValueSelect };
}
