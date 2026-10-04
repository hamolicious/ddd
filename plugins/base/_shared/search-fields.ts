import { useEffect, useState } from "react";

import type { SearchApi, SearchFieldInfo, SearchFieldsWatch, SearchValueKind, Unsubscribe } from "@kernel";

import { FIELD_OPTIONS, type FieldOption, type Suggestions, type ValueKind } from "./conditions.js";

const KINDS: Readonly<Record<SearchValueKind, ValueKind>> = {
  text: "str",
  reference: "doc",
  number: "float",
  boolean: "bool",
  date: "date",
  null: "null",
};

const LABELS = new Map(FIELD_OPTIONS.map((option) => [option.field, option.label] as const));

const UNSORTABLE = new Set(["content"]);

export function fieldOption(info: SearchFieldInfo): FieldOption {
  const kinds = [...new Set(info.kinds.filter((kind) => kind !== "null").map((kind) => KINDS[kind]))];
  const kind: ValueKind | undefined = kinds.length === 1 ? kinds[0] : info.kinds.length === 1 ? KINDS[info.kinds[0] as SearchValueKind] : undefined;
  const key = info.field.startsWith("fm.") ? info.field.slice(3) : info.field;
  const label = info.builtIn
    ? (LABELS.get(info.field) ?? info.field)
    : info.documents === undefined
      ? key
      : `${key} · ${info.documents.toLocaleString()} ${info.documents === 1 ? "note" : "notes"}`;
  return {
    field: info.field,
    label,
    ...(kind !== undefined ? { kind } : {}),
    ...(kinds.length > 1 ? { kinds } : {}),
    list: info.list,
    sortable: !info.list && !UNSORTABLE.has(info.field),
  };
}

export interface ValueSuggestions {
  readonly values: (field: string) => readonly string[];
  readonly subscribe: (listener: () => void) => Unsubscribe;
}

export function useSearchSuggestions(search: SearchApi, values?: ValueSuggestions): Suggestions {
  const [fields, setFields] = useState<readonly FieldOption[] | undefined>(undefined);
  useEffect(() => {
    let watch: SearchFieldsWatch | undefined;
    let live = true;
    let off: Unsubscribe | undefined;
    void search.watchFields().then(
      (opened) => {
        if (!live) {
          opened.close();
          return;
        }
        watch = opened;
        setFields(opened.fields.map(fieldOption));
        off = opened.onChange((next) => setFields(next.map(fieldOption)));
      },
      () => setFields(undefined),
    );
    return () => {
      live = false;
      off?.();
      watch?.close();
    };
  }, [search]);
  const [suggestions, setSuggestions] = useState<Suggestions>(() => build(fields, values));
  useEffect(() => setSuggestions(build(fields, values)), [fields, values]);
  return suggestions;
}

function build(fields: readonly FieldOption[] | undefined, values: ValueSuggestions | undefined): Suggestions {
  return {
    fields: () => fields ?? FIELD_OPTIONS,
    values: (field) => values?.values(field) ?? [],
    subscribe: (listener) => values?.subscribe(listener) ?? (() => undefined),
  };
}
