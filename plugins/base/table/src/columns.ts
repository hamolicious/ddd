import type { CoreValue, DocumentRow } from "@kernel";

import { displayRow, inferKind } from "../../_shared/fm-display.js";
import type { FieldOption } from "../../_shared/conditions.js";

export interface TableSettings {
  readonly columns: readonly string[];
  readonly rows: number;
}

export const DEFAULT_COLUMNS: readonly string[] = [];
export const DEFAULT_ROWS = 10;
export const MAX_ROWS = 200;
export const DEFAULT_TABLE: TableSettings = { columns: DEFAULT_COLUMNS, rows: DEFAULT_ROWS };

export function clampRows(value: unknown): number {
  const number = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return DEFAULT_ROWS;
  return Math.min(MAX_ROWS, Math.max(1, Math.floor(number)));
}

export function tableFromOptions(options: Readonly<Record<string, string>>): TableSettings {
  const cols = options["cols"];
  const rows = options["rows"];
  return {
    columns: cols === undefined || cols === "" ? DEFAULT_COLUMNS : decodeColumns(cols),
    rows: rows === undefined || rows === "" ? DEFAULT_ROWS : clampRows(rows),
  };
}

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

export const MATCH_COLUMN = "match";

export const FIXED_COLUMNS: readonly FieldOption[] = [
  { field: MATCH_COLUMN, label: "Match", kind: "str", sortable: false },
  { field: "updated_at", label: "Updated", kind: "date", sortable: true },
  { field: "created_at", label: "Created", kind: "date", sortable: true },
];

const FM_PATH = /^fm\.[A-Za-z0-9_-]{1,64}(?:\.[A-Za-z0-9_-]{1,64})*$/;

export function isColumn(field: string): boolean {
  return FIXED_COLUMNS.some((column) => column.field === field) || FM_PATH.test(field);
}

export function columnForKey(typed: string): string | undefined {
  const trimmed = typed.trim();
  const field = trimmed.startsWith("fm.") ? trimmed : `fm.${trimmed}`;
  return FM_PATH.test(field) ? field : undefined;
}

export function columnLabel(field: string): string {
  return FIXED_COLUMNS.find((column) => column.field === field)?.label ?? field.replace(/^fm\./, "");
}

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

export function encodeColumns(columns: readonly string[]): string {
  return columns.join(",");
}

export function decodeColumns(raw: string): readonly string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const field = part.trim();
    if (field !== "" && isColumn(field)) seen.add(field);
  }
  return [...seen];
}

export function cellText(row: DocumentRow, field: string): string {
  if (field === "updated_at") return formatWhen(row.updated_at);
  if (field === "created_at") return formatWhen(row.created_at);
  if (!field.startsWith("fm.")) return "";
  const key = field.slice(3);
  return displayRow({ key, value: valueAt(row.fm, key), kind: inferKind(key, valueAt(row.fm, key)) }).text;
}

function valueAt(fm: DocumentRow["fm"], path: string): CoreValue | undefined {
  let value: CoreValue | undefined = fm;
  for (const step of path.split(".")) {
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as { readonly [key: string]: CoreValue })[step];
  }
  return value;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}
