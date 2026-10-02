import type { CoreValue } from "@kernel";

export type PropertyKind = "string" | "number" | "boolean" | "date" | "array" | "map" | "null";

export interface PropertyRow {
  readonly key: string;
  readonly value: CoreValue | undefined;
  readonly kind: PropertyKind;
}

export const PREFERRED_KEY_ORDER: readonly string[] = [
  "title",
  "path",
  "date",
  "due",
  "status",
  "tags",
  "aliases",
];

const DATE_KEY = /(^|[_-])date$|[a-z0-9]Date$|^due$|^created$|^updated$|[_-]at$|[a-z0-9]At$/;

export const ISO_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:[Zz]|[+-]\d{2}:?(?:\d{2})?)?$/;

export function isDateKey(key: string): boolean {
  return DATE_KEY.test(key);
}

export function isIsoDateLike(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_ONLY.exec(value) ?? ISO_DATE_TIME.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  if (day > daysInMonth(year, month)) return false;
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  return hour <= 23 && minute <= 59 && second <= 60;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function inferKind(key: string, value: CoreValue | undefined): PropertyKind {
  if (value === undefined || value === null) return isDateKey(key) ? "date" : "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return isIsoDateLike(value) || isDateKey(key) ? "date" : "string";
  return "map";
}

export function rowsFromFm(
  fm: Readonly<Record<string, CoreValue>> | undefined,
): readonly PropertyRow[] {
  const entries = Object.entries(fm ?? {});
  const rank = (key: string): number => {
    const index = PREFERRED_KEY_ORDER.indexOf(key);
    return index === -1 ? PREFERRED_KEY_ORDER.length : index;
  };
  return entries
    .map(([key, value]) => ({ key, value, kind: inferKind(key, value) }))
    .sort((a, b) => {
      const byRank = rank(a.key) - rank(b.key);
      if (byRank !== 0) return byRank;
      return a.key.localeCompare(b.key, "en", { sensitivity: "base" }) || a.key.localeCompare(b.key);
    });
}

export function formatScalar(value: CoreValue | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => formatScalar(item)).join(", ");
  return JSON.stringify(value);
}

export interface FmDisplayRow {
  readonly key: string;
  readonly kind: PropertyKind;
  readonly raw: string;
  readonly text: string;
  readonly items?: readonly string[];
  readonly empty: boolean;
}

export function fmDisplayRows(
  fm: Readonly<Record<string, CoreValue>> | undefined,
): readonly FmDisplayRow[] {
  return rowsFromFm(fm).map(displayRow);
}

export function displayRow(row: PropertyRow): FmDisplayRow {
  const raw = formatScalar(row.value);

  if (row.kind === "array") {
    const items = (Array.isArray(row.value) ? row.value : [])
      .map((item) => formatScalar(item))
      .filter((item) => item.length > 0);
    return {
      key: row.key,
      kind: row.kind,
      raw,
      text: items.join(", "),
      items,
      empty: items.length === 0,
    };
  }

  if (row.value === undefined || row.value === null || raw.length === 0) {
    return { key: row.key, kind: row.kind, raw, text: "", empty: true };
  }

  if (row.kind === "boolean") {
    return {
      key: row.key,
      kind: row.kind,
      raw,
      text: row.value === true ? "Yes" : "No",
      empty: false,
    };
  }

  if (row.kind === "date") {
    return { key: row.key, kind: row.kind, raw, text: formatDateValue(raw), empty: false };
  }

  return { key: row.key, kind: row.kind, raw, text: raw, empty: false };
}

export function formatDateValue(value: string): string {
  if (!isIsoDateLike(value)) return value;

  const dateOnly = ISO_DATE_ONLY.exec(value);
  if (dateOnly) {
    const year = Number(dateOnly[1]);
    const local = new Date(year, Number(dateOnly[2]) - 1, Number(dateOnly[3]));
    local.setFullYear(year);
    return Number.isNaN(local.getTime())
      ? value
      : local.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
