/**
 * Bucketing dated documents into the agenda's day groups.
 *
 * The agenda reads **`fm.date`**, not "calendar events" (see the note at the top of
 * `index.tsx`): a note with a date, a task with a due date and an imported meeting are the
 * same thing here, which is why this plugin does not depend on `calendar` and works in a
 * workspace that has never installed it.
 *
 * Two shapes of ordering matter and both are deliberate:
 *
 * - **Overdue first, then forward in time.** Not "nearest first": the thing you missed is
 *   the thing you need to see, and it is the one bucket that never appears on its own date.
 * - **Inside a day: timed before untimed, then by title.** A row whose `fm.date` carries an
 *   `HH:MM` is an appointment; a row with a bare date is a whole-day item and has no claim
 *   on a position among the timed ones. Ties fall back to the title and then the id, so the
 *   list is stable across re-queries — an agenda that reshuffles when an unrelated document
 *   changes is one nobody can point at.
 */

import type { DocumentRow } from "@kernel";

import { dateKeyOf, dayDifference, labelForDay, timeOfDay, type DayKey } from "./dates.js";

/** The bucket key for everything before today. Not a date, because it spans many. */
export const OVERDUE_KEY = "overdue";

/** One group of documents under a heading (`Today`, `Tomorrow`, a date). */
export interface AgendaGroup {
  /** `YYYY-MM-DD`, or {@link OVERDUE_KEY} for the bucket before today. */
  readonly key: string;
  readonly label: string;
  readonly rows: readonly DocumentRow[];
}

/** A row with its resolved day and time — what the list renders. */
export interface DatedRow {
  readonly row: DocumentRow;
  readonly day: DayKey;
  readonly time?: string;
}

/** The `fm.date` of a row as a day key, or `undefined` when it has no usable date. */
export function dayOf(row: DocumentRow): DayKey | undefined {
  return dateKeyOf(row.fm["date"]);
}

/** The `HH:MM` of a row's `fm.date`, when it carried one. */
export function timeOf(row: DocumentRow): string | undefined {
  return timeOfDay(row.fm["date"]);
}

/**
 * Group `rows` into `overdue` + one bucket per day from `today` to `today + horizonDays`.
 *
 * Rows without a parseable `fm.date`, and rows beyond the horizon, are dropped: this is a
 * glance at what is close, and `doc-list` is where "every document with a date" lives.
 * Empty days produce no bucket — a run of empty headings is noise, not information.
 */
export function groupsOf(
  rows: readonly DocumentRow[],
  today: DayKey,
  horizonDays: number,
): readonly AgendaGroup[] {
  const horizon = Math.max(0, Math.trunc(horizonDays));
  const buckets = new Map<string, DatedRow[]>();

  for (const row of rows) {
    const day = dayOf(row);
    if (!day) continue;
    const offset = dayDifference(today, day);
    if (offset > horizon) continue;
    const key = offset < 0 ? OVERDUE_KEY : day;
    const entry: DatedRow = { row, day, time: timeOf(row) };
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => {
      if (a === b) return 0;
      if (a === OVERDUE_KEY) return -1;
      if (b === OVERDUE_KEY) return 1;
      return a < b ? -1 : 1;
    })
    .map(([key, entries]) => ({
      key,
      label: key === OVERDUE_KEY ? "Overdue" : labelForDay(key, today),
      rows: sortWithin(key, entries).map((entry) => entry.row),
    }));
}

/** Timed before untimed, then title, then id. The overdue bucket sorts by day first. */
function sortWithin(key: string, entries: readonly DatedRow[]): readonly DatedRow[] {
  return [...entries].sort((a, b) => {
    if (key === OVERDUE_KEY && a.day !== b.day) return a.day < b.day ? -1 : 1;
    const at = a.time ?? "";
    const bt = b.time ?? "";
    if (at !== bt) {
      if (at === "") return 1;
      if (bt === "") return -1;
      return at < bt ? -1 : 1;
    }
    return a.row.title.localeCompare(b.row.title) || a.row.id.localeCompare(b.row.id);
  });
}
