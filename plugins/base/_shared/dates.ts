/**
 * Dates out of documents, for views that place notes in time (`calendar`, `timeline`).
 *
 * A view is told *which field* holds a note's date — `created_at`, `updated_at`, or any
 * frontmatter key (`fm.date`, `fm.project.due`) — and reads it with {@link dateOf}. Two
 * rules make the answer right rather than nearly right:
 *
 * - **A date-only value is a local day.** `2026-09-23` is never put through
 *   `new Date(string)`, which reads it as UTC midnight and, west of Greenwich, lands it on
 *   the 22nd (the same rule as `fm-display.ts`'s `formatDateValue`).
 * - **Only what the core would call a date is one** (`isIsoDateLike`): `2026-02-30` is
 *   not a day, so the note is left out rather than moved to March.
 *
 * The rest is day arithmetic in local time, and {@link isoDay} — the `YYYY-MM-DD` a
 * filter's date literal takes.
 */

import type { CoreValue, DocumentRow } from "@kernel";

import { ISO_DATE_ONLY, isIsoDateLike } from "./fm-display.js";

/** The projection's own date fields, as a view's settings offer them. */
export const FIXED_DATE_FIELDS: readonly { readonly field: string; readonly label: string }[] = [
  { field: "created_at", label: "Created" },
  { field: "updated_at", label: "Updated" },
];

/** A field's value on a row: a fixed root, or a dotted frontmatter path (`fm.a.b`). */
export function fieldValue(row: DocumentRow, field: string): CoreValue | undefined {
  if (field === "created_at") return row.created_at;
  if (field === "updated_at") return row.updated_at;
  if (field === "deleted_at") return row.deleted_at;
  if (field === "title") return row.title;
  if (!field.startsWith("fm.")) return undefined;
  let value: CoreValue | undefined = row.fm;
  for (const step of field.slice(3).split(".")) {
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as { readonly [key: string]: CoreValue })[step];
  }
  return value;
}

/** A date string as a `Date`: a date-only one at local midnight. `undefined` for anything else. */
export function parseDate(value: unknown): Date | undefined {
  if (!isIsoDateLike(value)) return undefined;
  const text = value as string;
  const day = ISO_DATE_ONLY.exec(text);
  if (day) {
    const date = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    date.setFullYear(Number(day[1]));
    return date;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** The note's date in `field`, or `undefined` when it has none (or not a date). */
export function dateOf(row: DocumentRow, field: string): Date | undefined {
  return parseDate(fieldValue(row, field));
}

/** Whether the field's value on this row is a date without a time. */
export function isDateOnly(row: DocumentRow, field: string): boolean {
  const value = fieldValue(row, field);
  return typeof value === "string" && ISO_DATE_ONLY.test(value);
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes());
}

export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/** The Monday on or before `date`. */
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

/** A local day as `YYYY-MM-DD`: a key for grouping, and a filter's date literal. */
export function isoDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** Whole days from `a` to `b`, by the calendar (a DST change does not make a day short). */
export function daysBetween(a: Date, b: Date): number {
  const utc = (date: Date): number => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

/**
 * The conditions that keep a search to notes whose `field` falls in `[from, to)`, a day
 * wider each side so a time zone never drops one at the edge; the view trims the rest.
 */
export function rangeClauses(
  field: string,
  from: Date,
  to: Date,
): readonly { id: string; field: string; op: "gte" | "lt"; kind: "date"; value: string }[] {
  return [
    { id: `range-${field}-from`, field, op: "gte", kind: "date", value: isoDay(addDays(from, -1)) },
    { id: `range-${field}-to`, field, op: "lt", kind: "date", value: isoDay(addDays(to, 1)) },
  ];
}
