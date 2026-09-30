/**
 * The calendar's arithmetic, pure: which days a month shows, and which notes fall on each.
 *
 * A note is placed by the field the view's settings name (`date`, `created_at` by
 * default) and, when an end field is set, runs across every day up to that one. A note
 * without a date in the field is not on the calendar. An end before the start, or one
 * that is not a date, makes it a one-day entry.
 */

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

/** Weeks a month grid shows: always six, so the grid never changes height. */
export const GRID_DAYS = 42;

/** How long a spanning note may have started before the grid and still be fetched. */
const SPAN_LOOKBACK_DAYS = 62;

export interface CalendarOptions {
  /** The field a note's day comes from. */
  readonly date: string;
  /** The field its last day comes from; `""` for single-day notes. */
  readonly end: string;
}

export function calendarOptions(options: Readonly<Record<string, string>>): CalendarOptions {
  return { date: options["date"] || DEFAULT_DATE_FIELD, end: options["end"] ?? "" };
}

/** The view options for these settings over `options`; defaults are removed, not written. */
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

/** The 42 days a month's grid shows, from the Monday on or before its first. */
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

/**
 * The search conditions that fetch what a grid can show: notes whose day is in it, or —
 * with an end field — that started up to two months before it and may still be running.
 */
export function gridClauses(settings: CalendarOptions, from: Date, to: Date): ReturnType<typeof rangeClauses> {
  return settings.end === "" ? rangeClauses(settings.date, from, to) : rangeClauses(settings.date, addDays(from, -SPAN_LOOKBACK_DAYS), to);
}

/** Every note on each day of `[from, to)`, keyed by {@link isoDay}, in the rows' order. */
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
