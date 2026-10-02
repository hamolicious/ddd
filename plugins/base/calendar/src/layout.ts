import type { DocumentRow } from "@kernel";

import {
  addDays,
  addMonths,
  dateOf,
  isoDay,
  rangeClauses,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from "../../_shared/dates.js";

export const DEFAULT_DATE_FIELD = "created_at";

export const GRID_DAYS = 42;

const SPAN_LOOKBACK_DAYS = 62;

export interface CalendarOptions {
  readonly date: string;
  readonly end: string;
}

export function calendarOptions(options: Readonly<Record<string, string>>): CalendarOptions {
  return { date: options["date"] || DEFAULT_DATE_FIELD, end: options["end"] ?? "" };
}

export function withCalendar(
  settings: CalendarOptions,
  options: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const { date: _date, end: _end, ...rest } = options;
  return {
    ...rest,
    ...(settings.date === DEFAULT_DATE_FIELD ? {} : { date: settings.date }),
    ...(settings.end === "" ? {} : { end: settings.end }),
  };
}

export function monthGrid(month: Date): readonly Date[] {
  const first = startOfWeek(startOfMonth(month));
  return Array.from({ length: GRID_DAYS }, (_, index) => addDays(first, index));
}

export function shiftMonth(month: Date, by: number): Date {
  return addMonths(month, by);
}

export interface Entry {
  readonly row: DocumentRow;
  readonly start: Date;
  readonly end: Date;
}

export function gridClauses(settings: CalendarOptions, from: Date, to: Date): ReturnType<typeof rangeClauses> {
  return settings.end === "" ? rangeClauses(settings.date, from, to) : rangeClauses(settings.date, addDays(from, -SPAN_LOOKBACK_DAYS), to);
}

export function entriesByDay(
  rows: readonly DocumentRow[],
  settings: CalendarOptions,
  from: Date,
  to: Date,
): ReadonlyMap<string, readonly Entry[]> {
  const days = new Map<string, Entry[]>();
  const first = startOfDay(from);
  const last = addDays(startOfDay(to), -1);
  for (const row of rows) {
    const start = dateOf(row, settings.date);
    if (!start) continue;
    const endDate = settings.end === "" ? undefined : dateOf(row, settings.end);
    const end = endDate && endDate >= start ? endDate : start;
    const entry: Entry = { row, start, end };
    let day = startOfDay(start) < first ? first : startOfDay(start);
    const stop = startOfDay(end) > last ? last : startOfDay(end);
    for (; day <= stop; day = addDays(day, 1)) {
      const key = isoDay(day);
      const list = days.get(key) ?? [];
      list.push(entry);
      days.set(key, list);
    }
  }
  return days;
}
