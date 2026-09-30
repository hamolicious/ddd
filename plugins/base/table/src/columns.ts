/**
 * The results table: its columns, and how many rows it shows at a time.
 *
 * The title is always the first column; the columns here are the rest,
 * named by the filter language's field paths — `updated_at`, `created_at`, or
 * `fm.<key>` (dotted for a nested key) — so a column is also a sort key, as-is. The one
 * exception is {@link MATCH_COLUMN}, a search result's matched line.
 *
 * The table is {@link TableSettings.rows} rows tall and scrolls the rest inside itself,
 * loading them a page of that size at a time — so an embedded search is a box, not the
 * whole result set down the page.
 *
 * Both are the table's settings: `cols` and `rows` in a saved search's `%%% table` section,
 * or `t.cols` and `t.rows` in the all-documents page's URL. Defaults are left out.
 */

import type { CoreValue, DocumentRow } from "@kernel";

import { displayRow, inferKind } from "../../_shared/fm-display.js";
import type { FieldOption } from "../../_shared/conditions.js";

export interface TableSettings {
  /** Columns after the title, as field paths. */
  readonly columns: readonly string[];
  /** Rows shown at a time; also the page size. */
  readonly rows: number;
}

/** The title alone, ten rows at a time. */
export const DEFAULT_COLUMNS: readonly string[] = [];
export const DEFAULT_ROWS = 10;
export const MAX_ROWS = 200;
export const DEFAULT_TABLE: TableSettings = { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS };

/** A typed row count, clamped to 1…{@link MAX_ROWS}; junk is the default. */
export function clampRows(value: unknown): number {
  const number = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return DEFAULT_ROWS;
  return Math.min(MAX_ROWS, Math.max(1, Math.floor(number)));
}

/** The table a search's view options describe; the defaults for what they leave out. */
export function tableFromOptions(options: Readonly<Record<string, string>>): TableSettings {
  const cols = options["cols"];
  const rows = options["rows"];
  return {
    columns: cols === undefined || cols === "" ? DEFAULT_COLUMNS : decodeColumns(cols),
    rows: rows === undefined || rows === "" ? DEFAULT_ROWS : clampRows(rows),
  };
}

/** The view options for a table, over `options`: a default is removed, not written. */
export function tableOptions(
  table: TableSettings,
  options: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const { cols: _cols, rows: _rows, ...rest } = options;
  return {
    ...rest,
    ...(sameColumns(table.columns, DEFAULT_COLUMNS) ? {} : { cols: encodeColumns(table.columns) }),
    ...(table.rows === DEFAULT_ROWS ? {} : { rows: String(table.rows) }),
  };
}

/**
 * A search result's matched line, its terms marked. Not a field: nothing sorts on it,
 * and without a search the cell is empty.
 */
export const MATCH_COLUMN = "match";

/** The columns a table can show besides properties: the projection's own, and the match. */
export const FIXED_COLUMNS: readonly FieldOption[] = [
  { field: MATCH_COLUMN, label: "Match", kind: "str", sortable: false },
  { field: "updated_at", label: "Updated", kind: "date", sortable: true },
  { field: "created_at", label: "Created", kind: "date", sortable: true },
];

const FM_PATH = /^fm\.[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64})*$/;

/** Whether `field` names a column this table can draw. */
export function isColumn(field: string): boolean {
  return FIXED_COLUMNS.some((column) => column.field === field) || FM_PATH.test(field);
}

/** The column for a property typed by hand: `status` or `fm.status` → `fm.status`. */
export function columnForKey(typed: string): string | undefined {
  const trimmed = typed.trim();
  const field = trimmed.startsWith("fm.") ? trimmed : `fm.${trimmed}`;
  return FM_PATH.test(field) ? field : undefined;
}

export function columnLabel(field: string): string {
  return FIXED_COLUMNS.find((column) => column.field === field)?.label ?? field.replace(/^fm\./, "");
}

/** A column as a sort option: the fixed ones are dates, a property sorts as text. */
export function columnOption(field: string): FieldOption {
  return (
    FIXED_COLUMNS.find((column) => column.field === field) ?? {
      field,
      label: columnLabel(field),
      kind: "str",
      sortable: true,
    }
  );
}

export function sameColumns(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((field, index) => field === b[index]);
}

/** The URL form: comma-separated. */
export function encodeColumns(columns: readonly string[]): string {
  return columns.join(",");
}

/** Columns out of `cols`; an unknown one is dropped, a repeat is kept once. */
export function decodeColumns(raw: string): readonly string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const field = part.trim();
    if (field !== "" && isColumn(field)) seen.add(field);
  }
  return [...seen];
}

/** What a cell shows. `""` for nothing. */
export function cellText(row: DocumentRow, field: string): string {
  if (field === "updated_at") return formatWhen(row.updated_at);
  if (field === "created_at") return formatWhen(row.created_at);
  if (!field.startsWith("fm.")) return "";
  const key = field.slice(3);
  return displayRow({ key, value: valueAt(row.fm, key), kind: inferKind(key, valueAt(row.fm, key)) }).text;
}

/** A dotted path into the frontmatter; `undefined` when any step is missing. */
function valueAt(fm: DocumentRow["fm"], path: string): CoreValue | undefined {
  let value: CoreValue | undefined = fm;
  for (const step of path.split(".")) {
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as { readonly [key: string]: CoreValue })[step];
  }
  return value;
}

/**
 * Timestamps are shown, never compared: ordering is `seq` and the CRDT (PROTOCOL.md §5),
 * and this is a label.
 */
export function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
