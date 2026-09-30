/**
 * What the condition editor suggests, from the indexer (`lm/workspace-index`): the
 * frontmatter keys in use, the values each one holds, and the notes to pick for a
 * document value. All of it local and synchronous; a host without the index passes
 * nothing and the editor falls back to the fixed fields.
 */

import type { Unsubscribe } from "@kernel";

import type { FmField, PropertyKind, WorkspaceIndex } from "plugin:indexer";

import { DOC_PREFIX, FIELD_OPTIONS, type FieldOption, type ValueKind } from "./conditions.js";
import type { NoteLook, NoteSource, PickableNote } from "./note-picker.js";

/** The index as the conditions read it: a host's manifest `needs` these. */
export type ConditionIndex = Pick<WorkspaceIndex, "fmFields" | "fmValues" | "documents" | "subscribe" | "version">;

export interface Suggestions {
  /** The fixed roots, then every frontmatter key a person wrote, most-used first. */
  fields(): readonly FieldOption[];
  /** What `field` holds, most-used first; `[]` for anything but a frontmatter key. */
  values(field: string): readonly string[];
  /** Fires whenever either answer may have changed. */
  subscribe(listener: () => void): Unsubscribe;
}

/** The fields the index cannot know: the projection's own columns. */
const FIXED = FIELD_OPTIONS.filter((option) => !option.field.startsWith("fm."));

const VALUE_LIMIT = 50;

/** The most common of `kinds`, `undefined` for none. */
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

/**
 * The value type a field's conditions should compare with, from what it holds. A list
 * takes the kind of its items; strings that are all `doc://` links are documents.
 */
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

/**
 * Every note for the picker, from the index: offline, synchronous, live. `looks` dresses
 * them as the tree does, and its changes are announced with the index's.
 */
export function indexNoteSource(
  index: Pick<ConditionIndex, "documents" | "subscribe" | "version">,
  looks?: { readonly look: (id: string) => NoteLook | undefined; readonly onChange: (listener: () => void) => Unsubscribe },
): NoteSource {
  // Rebuilt only when the index moves, so the picker's memo holds between changes.
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
