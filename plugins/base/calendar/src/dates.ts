/**
 * The calendar's arithmetic: months, grids, and the one query behind the view.
 *
 * Pure functions, no React and no kernel calls — so the interesting decisions are
 * assertable in `dates.test.ts` rather than reachable only through a rendered grid.
 *
 * # Two decisions worth knowing before changing anything here
 *
 * **1. A row's day is the day its frontmatter says — no timezone conversion.**
 * `fm.date` reaches the projection in the shared core's canonical form (SPEC §3.4):
 * `2026-09-24` or `2026-09-24T09:00:00.000Z`. This module takes the first ten characters
 * and puts the row on that day. It deliberately does **not** convert to the viewer's zone,
 * for two reasons: M4 ships no timezone database, so the backend half stores a zoned or
 * floating event's *wall-clock* value (there is no offset to convert *from*); and the day a
 * row sorts into is then identical on every client and identical to what the filter DSL's
 * byte-wise date comparison does. A 23:30 UTC meeting therefore sits on the 24th for
 * everyone, which is the same answer the document itself gives.
 *
 * **2. "Today" is the viewer's local day.** The one place a local calendar is right: "today"
 * is a claim about the person looking at the screen, not about a stored value. The asymmetry
 * with the rule above is real and bounded — it can only ever be one day wide — and the
 * alternative (a "today" that disagrees with the device clock) is worse.
 */

import type { DocumentQuery, DocumentRow, FilterJson } from "@kernel";

/** `YYYY-MM-DD`. */
export type DayKey = string;
/** `YYYY-MM`. */
export type MonthKey = string;

/** Cells in a month grid: six weeks, so every month fits without the grid resizing. */
export const GRID_WEEKS = 6;
export const GRID_DAYS = GRID_WEEKS * 7;

/**
 * Rows one month's query may return.
 *
 * A bound, not a page: a month grid that would need more than this is not a grid any more,
 * and an unbounded query over a large workspace is exactly the "browse through the server"
 * pattern the kernel's local-first design exists to avoid (SPEC §4.1).
 */
export const ROW_LIMIT = 2_000;

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Weekday headings, Monday first (ISO-8601's week start). */
export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export function isMonthKey(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

export function isDayKey(value: string): boolean {
  return DAY_PATTERN.test(value);
}

/** The month a day belongs to. */
export function monthOf(day: DayKey): MonthKey {
  return day.slice(0, 7);
}

/** The viewer's local day, as a key. */
export function todayKey(now: Date = new Date()): DayKey {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** The month a viewer means by "this month". */
export function currentMonth(now: Date = new Date()): MonthKey {
  return monthOf(todayKey(now));
}

/** `September 2026`. */
export function monthLabel(month: MonthKey): string {
  const index = Number(month.slice(5, 7)) - 1;
  const name = MONTH_NAMES[index] ?? month.slice(5, 7);
  return `${name} ${month.slice(0, 4)}`;
}

/** A human day label for a list heading: `Thu 24 Sep`. */
export function dayLabel(day: DayKey): string {
  const at = utcDate(day);
  const weekday = WEEKDAY_LABELS[weekIndex(day)] ?? "";
  const month = (MONTH_NAMES[at.getUTCMonth()] ?? "").slice(0, 3);
  return `${weekday} ${at.getUTCDate()} ${month}`;
}

/** Move a month by whole months. `shiftMonth("2026-01", -1) === "2025-12"`. */
export function shiftMonth(month: MonthKey, delta: number): MonthKey {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7)) - 1 + delta;
  const shiftedYear = year + Math.floor(index / 12);
  const shiftedMonth = ((index % 12) + 12) % 12;
  return `${`${shiftedYear}`.padStart(4, "0")}-${`${shiftedMonth + 1}`.padStart(2, "0")}`;
}

/** Move a day by whole days. UTC arithmetic, so there is no DST to be wrong about. */
export function addDays(day: DayKey, delta: number): DayKey {
  const at = utcDate(day);
  at.setUTCDate(at.getUTCDate() + delta);
  return at.toISOString().slice(0, 10);
}

/** 0 = Monday … 6 = Sunday. */
export function weekIndex(day: DayKey): number {
  return (utcDate(day).getUTCDay() + 6) % 7;
}

/** The half-open window a month's grid covers. */
export interface GridWindow {
  /** First cell, a Monday on or before the 1st. */
  readonly start: DayKey;
  /** One day past the last cell — the exclusive bound the query uses. */
  readonly endExclusive: DayKey;
  /** All 42 day keys, in order. */
  readonly days: readonly DayKey[];
}

/**
 * The six-week window a month is drawn in.
 *
 * Always six weeks, never five-or-six: a grid that changes height as you page through months
 * makes every event jump, and the extra row costs one line of CSS.
 */
export function monthGrid(month: MonthKey): GridWindow {
  const first = `${month}-01`;
  const start = addDays(first, -weekIndex(first));
  const days: DayKey[] = [];
  for (let index = 0; index < GRID_DAYS; index += 1) days.push(addDays(start, index));
  return { start, endExclusive: addDays(start, GRID_DAYS), days };
}

/**
 * The filter for everything visible in a window — **the whole data dependency of this
 * plugin's view.**
 *
 * It asks for *intersection*, not containment: a conference that started last month and ends
 * inside the window belongs on screen, and `fm.date`-only bounds would drop it. Hence the
 * `or` over `fm.date` and `fm.date-end`.
 *
 * The comparisons use the DSL's **explicit date type** (SPEC §4.2), which the shared
 * evaluator applies to canonical date strings byte-wise. That is why the upper bound is
 * `lt` an exclusive day rather than `lte` the last day: `2026-10-11T09:00:00.000Z` is
 * greater than `2026-10-11`, so a `lte` bound would silently drop every timed event on the
 * final day.
 */
export function windowFilter(window: GridWindow): FilterJson {
  return {
    and: [
      { exists: { field: "fm.date" } },
      { cmp: { field: "fm.date", op: "lt", value: { date: window.endExclusive } } },
      {
        or: [
          { cmp: { field: "fm.date", op: "gte", value: { date: window.start } } },
          { cmp: { field: "fm.date-end", op: "gte", value: { date: window.start } } },
        ],
      },
    ],
  };
}

/** The seven days of the week containing `day`, Monday first. */
export function weekWindow(day: DayKey): GridWindow {
  const start = addDays(day, -weekIndex(day));
  const days: DayKey[] = [];
  for (let index = 0; index < 7; index += 1) days.push(addDays(start, index));
  return { start, endExclusive: addDays(start, 7), days };
}

/** The live query behind any window — the month grid and the week list share it. */
export function windowQuery(window: GridWindow): DocumentQuery {
  return {
    filter: windowFilter(window),
    sort: [{ field: "fm.date", direction: "asc" }],
    limit: ROW_LIMIT,
  };
}

/** The live query behind a month view. */
export function monthQuery(month: MonthKey): DocumentQuery {
  return windowQuery(monthGrid(month));
}

/** The day part of a frontmatter date value, or `undefined` when it is not one. */
export function dayOfValue(value: unknown): DayKey | undefined {
  if (typeof value !== "string") return undefined;
  const day = value.slice(0, 10);
  return isDayKey(day) ? day : undefined;
}

/** `09:00` for a timed event; `undefined` for an all-day one. */
export function timeLabel(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 16 || value[10] !== "T") return undefined;
  return value.slice(11, 16);
}

/** The inclusive day span a row occupies, or `undefined` when it has no usable date. */
export function spanOf(row: DocumentRow): { readonly start: DayKey; readonly end: DayKey } | undefined {
  const start = dayOfValue(row.fm["date"]);
  if (!start) return undefined;
  const end = dayOfValue(row.fm["date-end"]);
  // An end before the start is a document a human edited into an impossible state; the start
  // is the value that is certainly meant, so the span collapses to it rather than vanishing.
  return { start, end: end && end > start ? end : start };
}

/** One day's cell in the grid. */
export interface CalendarDay {
  /** `YYYY-MM-DD`. */
  readonly date: DayKey;
  /** `false` for the leading/trailing days of the neighbouring months. */
  readonly inMonth: boolean;
  /** Rows on this day, timed first in clock order, all-day rows before them. */
  readonly rows: readonly DocumentRow[];
}

/**
 * Group rows into a month's 42 cells.
 *
 * A multi-day row appears in **every** cell it covers — that is what makes a week-long
 * holiday look like a week — so the same row legitimately appears more than once, and the
 * caller must key React elements by `${day}:${row.id}` rather than by id alone.
 */
export function daysOf(month: MonthKey, rows: readonly DocumentRow[]): readonly CalendarDay[] {
  return daysIn(monthGrid(month), rows, month);
}

/**
 * The same grouping over any window — what the week list uses.
 *
 * `month` decides which cells count as "in the month" for the grid's dimming; a week list
 * passes the week's own month, or none, and every cell is `inMonth`.
 */
export function daysIn(
  window: GridWindow,
  rows: readonly DocumentRow[],
  month?: MonthKey,
): readonly CalendarDay[] {
  const byDay = new Map<DayKey, DocumentRow[]>();
  for (const day of window.days) byDay.set(day, []);

  for (const row of rows) {
    const span = spanOf(row);
    if (!span) continue;
    // Clamp to the window before walking: a row with a ten-year `date-end` must not spin.
    let day = span.start < window.start ? window.start : span.start;
    while (day <= span.end && day < window.endExclusive) {
      byDay.get(day)?.push(row);
      day = addDays(day, 1);
    }
  }

  return window.days.map((date) => ({
    date,
    inMonth: month === undefined || monthOf(date) === month,
    rows: (byDay.get(date) ?? []).sort(compareRows),
  }));
}

/** All-day rows first, then timed rows in clock order, then by title — stable and obvious. */
export function compareRows(left: DocumentRow, right: DocumentRow): number {
  const leftTime = timeLabel(left.fm["date"]);
  const rightTime = timeLabel(right.fm["date"]);
  if (leftTime !== rightTime) {
    if (!leftTime) return -1;
    if (!rightTime) return 1;
    return leftTime < rightTime ? -1 : 1;
  }
  return left.title.localeCompare(right.title);
}

/** The non-empty days of a window, for the week/list rendering and for `agenda`-style reads. */
export function listOf(days: readonly CalendarDay[]): readonly CalendarDay[] {
  return days.filter((day) => day.rows.length > 0);
}

/** Split 42 cells into six weeks. */
export function weeksOf(days: readonly CalendarDay[]): readonly (readonly CalendarDay[])[] {
  const weeks: CalendarDay[][] = [];
  for (let index = 0; index < days.length; index += 7) weeks.push(days.slice(index, index + 7));
  return weeks;
}

/** `true` when this row came from an ICS feed rather than from a person. */
export function isImported(row: DocumentRow): boolean {
  return row.fm["source"] === "ical";
}

/** An imported event the feed has cancelled (the backend half splices `status: cancelled`). */
export function isCancelled(row: DocumentRow): boolean {
  const section = row.plugins["calendar"];
  if (!section || typeof section !== "object" || Array.isArray(section)) return false;
  return (section as { readonly [key: string]: unknown })["status"] === "cancelled";
}

function utcDate(day: DayKey): Date {
  return new Date(`${day}T00:00:00.000Z`);
}
