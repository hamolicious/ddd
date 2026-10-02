import { useMemo, useState, useSyncExternalStore } from "react";
import type { ComponentType, ReactElement } from "react";

import type { FmField, PropertyKind, WorkspaceIndex } from "plugin:indexer";
import type { FmKeySelectProps, FmValueSelectProps } from "../api.js";

import { DOC_PREFIX } from "../../../_shared/conditions.js";

import { Combobox, type ComboboxOptions } from "./Combobox.js";
import { NoteName } from "../../../_shared/note-picker.js";

import { type KnownNote, type NoteHooks } from "./notes.js";

export type FmIndex = Pick<WorkspaceIndex, "fmFields" | "fmValues" | "subscribe" | "version">;

interface Option {
  readonly value: string;
  readonly label?: string;
  readonly extras: readonly string[];
  readonly count?: number;
  readonly note?: { readonly id: string } & KnownNote;
}

export function linkedId(value: string): string | undefined {
  return value.startsWith(DOC_PREFIX) && value.length > DOC_PREFIX.length ? value.slice(DOC_PREFIX.length) : undefined;
}

const notesCount = (count: number): string => `${count.toLocaleString()} ${count === 1 ? "note" : "notes"}`;

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

export function lastItem(text: string): { readonly before: string; readonly item: string } {
  const comma = text.lastIndexOf(",");
  if (comma === -1) return { before: "", item: text };
  const rest = text.slice(comma + 1);
  const lead = rest.length - rest.trimStart().length;
  return { before: text.slice(0, comma + 1 + lead), item: rest.trimStart() };
}

function Row({ option, notes }: { readonly option: Option; readonly notes: NoteHooks }): ReactElement {
  return (
    <span className="search:flex search:h-[1.5em] search:min-w-0 search:flex-1 search:flex-wrap search:items-center search:gap-x-2 search:overflow-hidden search:leading-[1.5em]">
      <span className="search:min-w-0 search:max-w-full search:truncate">
        {option.note !== undefined ? (
          <NoteName title={option.note.title} look={notes.look(option.note.id)} />
        ) : (
          (option.label ?? option.value)
        )}
      </span>
      {option.extras.map((extra, at) => (
        <span
          key={at}
          className={`${at === 0 ? "search:ml-auto " : ""}search:whitespace-nowrap search:text-sm search:text-text-muted`}
        >
          {extra}
        </span>
      ))}
    </span>
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
      const fixed: Option[] = (builtIn ?? []).map((field) => ({ value: field.key, label: field.label, extras: ["built in"] }));
      const keys: Option[] = index
        .fmFields()
        .filter((field) => !field.machineOnly && commonest(field.kinds) !== "map")
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
        .map((field) => {
          const kind = commonest(field.kinds);
          return { value: field.key, extras: kind === undefined ? [notesCount(field.count)] : [notesCount(field.count), kind] };
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
            extras: note !== undefined && note.folder !== "" ? [notesCount(entry.count), note.folder] : [notesCount(entry.count)],
            count: entry.count,
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
    onPick,
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
        onPick={(option) => {
          onChange(option.value);
          onPick?.(option.value);
        }}
        empty="No property in use matches."
      />
    );
  }

  function FmValueSelect({
    fmKey,
    value,
    onChange,
    onPick,
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
        onPick={(option) => {
          const next = `${before}${option.value}`;
          onChange(next);
          onPick?.(next);
        }}
        empty={fmKey.trim() === "" ? "Choose a property first." : "No value in use matches."}
      />
    );
  }

  return { FmKeySelect, FmValueSelect };
}
