/**
 * The timeline's arithmetic, pure: the window of time on screen, and where each note sits
 * in it.
 *
 * - **Fields are the view's settings.** A note starts at its `start` field (`created_at`
 *   by default). With an `end` field it is a bar to that date — a date without a time is
 *   the whole day, so a one-day task is a day wide — and without one, or with an end that
 *   is missing or earlier, it is a point. With a `group` field the notes split into
 *   lanes by its value; a list value puts the note in each of its lanes, and notes without
 *   one share a lane at the bottom.
 * - **The window is the scale's.** Days show two weeks, weeks twelve, months a year —
 *   always starting on a boundary, so a column is a day, a week or a month.
 * - **Rows are packed.** In a lane, a note takes the first row where it does not overlap
 *   what is already there, with room kept after a point for its label.
 */

import type { DocumentRow } from "@kernel";

import {
  addDays,
  addMonths,
  dateOf,
  isDateOnly,
  fieldValue,
  rangeClauses,
  startOfMonth,
  startOfWeek,
} from "../../_shared/dates.js";

export type Scale = "day" | "week" | "month";
export const SCALES: readonly { readonly id: Scale; readonly label: string }[] = [
  { id: "day", label: "Days" },
  { id: "week", label: "Weeks" },
  { id: "month", label: "Months" },
];

export interface TimelineOptions {
  readonly start: string;
  /** `""`: every note is a point. */
  readonly end: string;
  /** `""`: one lane. */
  readonly group: string;
  readonly scale: Scale;
}

export const DEFAULTS: TimelineOptions = { start: "created_at", end: "", group: "", scale: "week" };

export function timelineOptions(options: Readonly<Record<string, string>>): TimelineOptions {
  const scale = SCALES.some((candidate) => candidate.id === options["scale"]) ? (options["scale"] as Scale) : DEFAULTS.scale;
  return { start: options["start"] || DEFAULTS.start, end: options["end"] ?? "", group: options["group"] ?? "", scale };
}

/** The view options for these settings over `options`; defaults are removed, not written. */
export function withTimeline(
  settings: TimelineOptions,
  options: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const { start: _s, end: _e, group: _g, scale: _c, ...rest } = options;
  return {
    ...rest,
    ...(settings.start === DEFAULTS.start ? {} : { start: settings.start }),
    ...(settings.end === "" ? {} : { end: settings.end }),
    ...(settings.group === "" ? {} : { group: settings.group }),
    ...(settings.scale === DEFAULTS.scale ? {} : { scale: settings.scale }),
  };
}

export interface Unit {
  readonly start: Date;
  readonly label: string;
}

export interface TimeWindow {
  readonly from: Date;
  readonly to: Date;
  readonly units: readonly Unit[];
}

/** The window around `anchor`: a little before it, most of it after. */
export function windowFor(anchor: Date, scale: Scale): TimeWindow {
  const units: Unit[] = [];
  if (scale === "month") {
    const from = addMonths(startOfMonth(anchor), -2);
    for (let index = 0; index < 12; index += 1) {
      const start = addMonths(from, index);
      units.push({ start, label: start.toLocaleDateString(undefined, { month: "short", ...(start.getMonth() === 0 || index === 0 ? { year: "numeric" } : {}) }) });
    }
    return { from, to: addMonths(from, 12), units };
  }
  const step = scale === "day" ? 1 : 7;
  const count = scale === "day" ? 14 : 12;
  const from = addDays(startOfWeek(anchor), scale === "day" ? 0 : -14);
  for (let index = 0; index < count; index += 1) {
    const start = addDays(from, index * step);
    units.push({
      start,
      label:
        scale === "day"
          ? start.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })
          : start.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    });
  }
  return { from, to: addDays(from, count * step), units };
}

/** Where ‹ and › move the anchor: about a third of a window. */
export function shiftAnchor(anchor: Date, scale: Scale, by: number): Date {
  if (scale === "month") return addMonths(anchor, 3 * by);
  return addDays(anchor, (scale === "day" ? 7 : 28) * by);
}

/**
 * The search conditions that fetch what a window can show: notes that start in it, or —
 * with an end field — that started up to a year before it and may still be running.
 */
export function windowClauses(settings: TimelineOptions, window: TimeWindow): ReturnType<typeof rangeClauses> {
  return settings.end === ""
    ? rangeClauses(settings.start, window.from, window.to)
    : rangeClauses(settings.start, addDays(window.from, -366), window.to);
}

export interface Item {
  readonly row: DocumentRow;
  readonly start: Date;
  /** Exclusive; equal to `start` for a point. */
  readonly end: Date;
  readonly point: boolean;
  /** Where it sits in the window, as fractions of its width. */
  readonly left: number;
  readonly right: number;
}

export interface Lane {
  /** The group value; `undefined` for the notes without one (and for the single lane). */
  readonly name: string | undefined;
  readonly rows: readonly (readonly Item[])[];
}

/** Room a point keeps after it for its label, and a bar's least width, as fractions. */
const POINT_ROOM = 0.14;
const BAR_ROOM = 0.06;

function lanesOf(row: DocumentRow, group: string): readonly (string | undefined)[] {
  if (group === "") return [undefined];
  const value = fieldValue(row, group);
  const names = (Array.isArray(value) ? value : [value])
    .filter((item) => item !== null && item !== undefined && item !== "" && typeof item !== "object")
    .map(String);
  return names.length === 0 ? [undefined] : [...new Set(names)];
}

/** The notes in the window, in lanes (named ones alphabetically, then the unnamed), rows packed. */
export function layoutItems(rows: readonly DocumentRow[], settings: TimelineOptions, window: TimeWindow): readonly Lane[] {
  const span = window.to.getTime() - window.from.getTime();
  const fraction = (date: Date): number => (date.getTime() - window.from.getTime()) / span;
  const byLane = new Map<string | undefined, Item[]>();

  for (const row of rows) {
    const start = dateOf(row, settings.start);
    if (!start) continue;
    let end = settings.end === "" ? undefined : dateOf(row, settings.end);
    if (end && isDateOnly(row, settings.end)) end = addDays(end, 1);
    const point = !end || end <= start;
    const stop = point ? start : (end as Date);
    if (point ? start < window.from || start >= window.to : stop <= window.from || start >= window.to) continue;
    const item: Item = { row, start, end: stop, point, left: fraction(start), right: fraction(stop) };
    for (const lane of lanesOf(row, settings.group)) {
      const list = byLane.get(lane) ?? [];
      list.push(item);
      byLane.set(lane, list);
    }
  }

  const names = [...byLane.keys()].sort((a, b) =>
    a === undefined ? 1 : b === undefined ? -1 : a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }),
  );
  return names.map((name) => ({ name, rows: pack(byLane.get(name) ?? []) }));
}

function pack(items: readonly Item[]): readonly (readonly Item[])[] {
  const rows: { items: Item[]; free: number }[] = [];
  for (const item of [...items].sort((a, b) => a.left - b.left || b.right - a.right)) {
    const taken = item.point ? item.left + POINT_ROOM : Math.max(item.right, item.left + BAR_ROOM);
    const row = rows.find((candidate) => candidate.free <= item.left);
    if (row) {
      row.items.push(item);
      row.free = taken;
    } else {
      rows.push({ items: [item], free: taken });
    }
  }
  return rows.map((row) => row.items);
}
