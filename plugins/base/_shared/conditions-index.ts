import type { Unsubscribe } from "@kernel";

import type { FmField, PropertyKind, WorkspaceIndex } from "plugin:indexer";

import { DOC_PREFIX, FIELD_OPTIONS, type FieldOption, type ValueKind } from "./conditions.js";
import type { NoteLook, NoteSource, PickableNote } from "./note-picker.js";

export type ConditionIndex = Pick<WorkspaceIndex, "fmFields" | "fmValues" | "documents" | "subscribe" | "version">;

export interface Suggestions {
  fields(): readonly FieldOption[];
  values(field: string): readonly string[];
  subscribe(listener: () => void): Unsubscribe;
}

const FIXED = FIELD_OPTIONS.filter((option) => !option.field.startsWith("fm."));

const VALUE_LIMIT = 50;

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

export function inferKind(field: FmField, values: readonly { readonly value: unknown }[]): ValueKind | undefined {
  const kind = commonest(field.kinds);
  const scalars = values.map((entry) => entry.value).filter((value) => value !== null);
  const numbers = (): ValueKind => (scalars.every((value) => Number.isInteger(value)) ? "int" : "float");
  const strings = (): ValueKind =>
    scalars.length > 0 && scalars.every((value) => typeof value === "string" && value.startsWith(DOC_PREFIX))
      ? "doc"
      : "str";
  switch (kind) {
    case "string":
      return strings();
    case "number":
      return numbers();
    case "boolean":
      return "bool";
    case "date":
      return "date";
    case "null":
      return "null";
    case "array": {
      const first = scalars[0];
      if (typeof first === "number") return numbers();
      if (typeof first === "boolean") return "bool";
      return strings();
    }
    default:
      return undefined;
  }
}

export function indexSuggestions(index: ConditionIndex): Suggestions {
  const human = (): readonly FmField[] => index.fmFields().filter((field) => !field.machineOnly && commonest(field.kinds) !== "map");
  return {
    fields: () => [
      ...FIXED,
      ...human().map((field): FieldOption => {
        const kind = inferKind(field, index.fmValues(field.key).slice(0, VALUE_LIMIT));
        return {
          field: `fm.${field.key}`,
          label: `${field.key} · ${field.count.toLocaleString()} ${field.count === 1 ? "note" : "notes"}`,
          ...(kind !== undefined ? { kind } : {}),
          list: commonest(field.kinds) === "array",
          sortable: false,
        };
      }),
    ],
    values: (field) =>
      field.startsWith("fm.")
        ? index
            .fmValues(field.slice(3))
            .slice(0, VALUE_LIMIT)
            .filter((entry) => entry.value !== null)
            .map((entry) => String(entry.value))
        : [],
    subscribe: (listener) => index.subscribe(listener),
  };
}

export function indexNoteSource(
  index: Pick<ConditionIndex, "documents" | "subscribe" | "version">,
  looks?: { readonly look: (id: string) => NoteLook | undefined; readonly onChange: (listener: () => void) => Unsubscribe },
): NoteSource {
  let cached: { readonly version: number; readonly notes: readonly PickableNote[] } | undefined;
  return {
    notes: () => {
      if (cached?.version !== index.version) {
        cached = {
          version: index.version,
          notes: index.documents().map((note) => ({ id: note.id, title: note.title, folder: note.folder })),
        };
      }
      return cached.notes;
    },
    subscribe: (listener) => {
      const offIndex = index.subscribe(listener);
      const offLooks = looks?.onChange(listener);
      return () => {
        offIndex();
        offLooks?.();
      };
    },
    ...(looks !== undefined ? { look: looks.look } : {}),
  };
}
