import type { CoreValue, DocumentRow } from "@kernel";

import { ISO_DATE_ONLY, isIsoDateLike } from "./fm-display.js";

export const FIXED_DATE_FIELDS: readonly { readonly field: string; readonly label: string }[] = [
  { field: "created_at", label: "Created" },
  { field: "updated_at", label: "Updated" },
];

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

export function dateOf(row: DocumentRow, field: string): Date | undefined {
  return parseDate(fieldValue(row, field));
}

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

export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  return addDays(day, -((day.getDay() + 6) % 7));
}

export function isoDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${String(date.getFullYear()).padStart(4, "0")}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function daysBetween(a: Date, b: Date): number {
  const utc = (date: Date): number => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((utc(b) - utc(a)) / 86_400_000);
}

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
