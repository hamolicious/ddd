/**
 * Saved searches and the views that show them, pure.
 *
 * A saved search is a note whose `saved-search` frontmatter holds a search's query string
 * (`search`'s `spec.ts`). Its `type` says how it is shown — `type: kanban`, or a list,
 * `type: [kanban, calendar]` — and each view plugin (`table`, `kanban`, `calendar`,
 * `timeline`) offers a `document.mode` for the notes whose type names it. The first type
 * is the one the note opens in. A saved search with no type is a table.
 *
 * **A view's settings are its own.** Each view keeps them in its own `%%% <plugin-id>`
 * section of the note, one key per line (SPEC §3.4) — a board's columns, a calendar's
 * date field — read from `row.plugins` and written with `spliceSection`, so two views of
 * one search never write the same line.
 */

import type { CoreMap, DocumentRow, SectionLineEdit, TextEdit } from "@kernel";
import type { SearchSpec } from "plugin:search";

import { yamlScalar } from "./yaml.js";

/** `search`'s saved-search key: a note holding it is a saved search. */
export const SAVED_SEARCH_KEY = "saved-search";
/** Which views show a saved search: a string or a list. */
export const TYPE_KEY = "type";
/** What a saved search with no type is shown as. */
export const DEFAULT_TYPE = "table";

/** A view's settings, as it keeps them: one string per key. */
export type ViewOptions = Readonly<Record<string, string>>;

/** The stored search on a note, or `undefined` when it is not a saved search. */
export function savedSearchOf(row: DocumentRow | undefined): string | undefined {
  const value = row?.fm[SAVED_SEARCH_KEY];
  return typeof value === "string" ? value : undefined;
}

export function isSavedSearch(row: DocumentRow): boolean {
  return savedSearchOf(row) !== undefined;
}

/** The note's types, in order: trimmed, lower-cased, each once; the table when it names none. */
export function typesOf(row: DocumentRow): readonly string[] {
  const raw = row.fm[TYPE_KEY];
  const values = Array.isArray(raw) ? raw : [raw];
  const types: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const type = value.trim().toLowerCase();
    if (type !== "" && !types.includes(type)) types.push(type);
  }
  return types.length > 0 ? types : [DEFAULT_TYPE];
}

/** A saved search one of whose types is `type`: the view's mode applies. */
export function showsAs(row: DocumentRow, type: string): boolean {
  return isSavedSearch(row) && typesOf(row).includes(type);
}

/** A saved search whose first type is `type`: the note opens in this view. */
export function opensAs(row: DocumentRow, type: string): boolean {
  return isSavedSearch(row) && typesOf(row)[0] === type;
}

/** A plugin's settings on a note: its section's scalar keys, as strings. */
export function sectionOptions(row: DocumentRow, pluginId: string): ViewOptions {
  const section = row.plugins?.[pluginId];
  if (section === null || typeof section !== "object" || Array.isArray(section)) return {};
  const options: Record<string, string> = {};
  for (const [key, value] of Object.entries(section as CoreMap)) {
    if (typeof value === "string") options[key] = value;
    else if (typeof value === "number" || typeof value === "boolean") options[key] = String(value);
  }
  return options;
}

/** The section lines that turn `before` into `after`: changed keys written, dropped ones removed. */
export function optionEdits(before: ViewOptions, after: ViewOptions): readonly SectionLineEdit[] {
  const edits: SectionLineEdit[] = [];
  for (const [key, value] of Object.entries(after)) {
    if (value === "") continue;
    if (before[key] !== value) edits.push({ key, value, remove: false });
  }
  for (const key of Object.keys(before)) {
    if (after[key] === undefined || after[key] === "") edits.push({ key, value: null, remove: true });
  }
  return edits;
}

export function sameOptions(a: ViewOptions, b: ViewOptions): boolean {
  return optionEdits(a, b).length === 0;
}

/** A title for a new saved search: the text searched for, or a generic one. */
export function savedSearchTitle(query: string): string {
  const trimmed = query.trim();
  return trimmed === "" ? "Saved search" : trimmed;
}

/**
 * The whole text of a new saved-search note: its title, its search and its types. Written
 * wholesale because at creation there is nothing to merge with (SPEC §3.3). One type is a
 * scalar; several are a list, one item per line.
 */
export function savedSearchNoteText(title: string, search: string, types: readonly string[]): string {
  const typeLines =
    types.length === 0
      ? []
      : types.length === 1
        ? [`${TYPE_KEY}: ${yamlScalar(types[0] as string)}`]
        : [`${TYPE_KEY}:`, ...types.map((type) => `  - ${yamlScalar(type)}`)];
  return ["---", `title: ${yamlScalar(title)}`, `${SAVED_SEARCH_KEY}: ${yamlScalar(search)}`, ...typeLines, "---", ""].join("\n");
}

/** Apply edits (in the original's offsets) to a plain string. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((x, y) => y.range.start - x.range.start)) {
    out = out.slice(0, edit.range.start) + edit.text + out.slice(edit.range.end);
  }
  return out;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A fresh ULID — 48 bits of milliseconds, 80 random — for a note whose text must name
 * its own id. `documents.create` takes a client-minted one (SPEC §3.5).
 */
export function newUlid(now: number = Date.now(), random: (bytes: Uint8Array) => Uint8Array = (bytes) => crypto.getRandomValues(bytes)): string {
  let time = "";
  let rest = now;
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD[rest % 32] + time;
    rest = Math.floor(rest / 32);
  }
  const bytes = random(new Uint8Array(16));
  let tail = "";
  for (let index = 0; index < 16; index += 1) tail += CROCKFORD[(bytes[index] as number) % 32];
  return time + tail;
}

/** A search for the notes inside `parent`: what a new view starts with. */
export function childrenSpec(parent: string): SearchSpec {
  return {
    query: "",
    filter: { combine: "and", clauses: [{ id: "children", field: "", op: "child_of", kind: "str", value: parent }] },
  };
}
