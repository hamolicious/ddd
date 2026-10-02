import type { CoreMap, DocumentRow, SectionLineEdit, TextEdit } from "@kernel";
import type { SearchSpec } from "plugin:search";

import { yamlScalar } from "./yaml.js";

export const SAVED_SEARCH_KEY = "saved-search";
export const TYPE_KEY = "type";
export const DEFAULT_TYPE = "table";

export type ViewOptions = Readonly<Record<string, string>>;

export function savedSearchOf(row: DocumentRow | undefined): string | undefined {
  const value = row?.fm[SAVED_SEARCH_KEY];
  return typeof value === "string" ? value : undefined;
}

export function isSavedSearch(row: DocumentRow): boolean {
  return savedSearchOf(row) !== undefined;
}

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

export function showsAs(row: DocumentRow, type: string): boolean {
  return isSavedSearch(row) && typesOf(row).includes(type);
}

export function opensAs(row: DocumentRow, type: string): boolean {
  return isSavedSearch(row) && typesOf(row)[0] === type;
}

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

export function savedSearchTitle(query: string): string {
  const trimmed = query.trim();
  return trimmed === "" ? "Saved search" : trimmed;
}

export function savedSearchNoteText(title: string, search: string, types: readonly string[]): string {
  const typeLines =
    types.length === 0
      ? []
      : types.length === 1
        ? [`${TYPE_KEY}: ${yamlScalar(types[0] as string)}`]
        : [`${TYPE_KEY}:`, ...types.map((type) => `  - ${yamlScalar(type)}`)];
  return ["---", `title: ${yamlScalar(title)}`, `${SAVED_SEARCH_KEY}: ${yamlScalar(search)}`, ...typeLines, "---", ""].join("\n");
}

export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = text;
  for (const edit of [...edits].sort((x, y) => y.range.start - x.range.start)) {
    out = out.slice(0, edit.range.start) + edit.text + out.slice(edit.range.end);
  }
  return out;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

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

export function childrenSpec(parent: string): SearchSpec {
  return {
    query: "",
    filter: { combine: "and", clauses: [{ id: "children", field: "", op: "child_of", kind: "str", value: parent }] },
  };
}
