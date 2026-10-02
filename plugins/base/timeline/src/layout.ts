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

export type Scale = "day" | "week" | "month" | "quarter";
export const SCALES: readonly { readonly id: Scale; readonly label: string }[] = [
  { id: "day", label: "Days" },
  { id: "week", label: "Weeks" },
  { id: "month", label: "Months" },
  { id: "quarter", label: "Quarters" },
];

export interface TimelineOptions {
  readonly start: string;
  readonly end: string;
  readonly group: string;
  readonly scale: Scale;
}

export const DEFAULTS: TimelineOptions = { start: "created_at", end: "", group: "", scale: "week" };

export function timelineOptions(options: Readonly<Record<string, string>>): TimelineOptions {
  const scale = SCALES.some((candidate) => candidate.id === options["scale"]) ? (options["scale"] as Scale) : DEFAULTS.scale;
  return { start: options["start"] || DEFAULTS.start, end: options["end"] ?? "", group: options["group"] ?? "", scale };
}

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
  if (scale === "quarter") {
    const month = startOfMonth(anchor);
    const from = addMonths(month, -(month.getMonth() % 3) - 6);
    for (let index = 0; index < 12; index += 1) {
      const start = addMonths(from, index * 3);
      const quarter = `Q${start.getMonth() / 3 + 1}`;
      units.push({ start, label: start.getMonth() === 0 || index === 0 ? `${quarter} ${start.getFullYear()}` : quarter });
    }
    return { from, to: addMonths(from, 36), units };
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

export function shiftAnchor(anchor: Date, scale: Scale, by: number): Date {
  if (scale === "month") return addMonths(anchor, 3 * by);
  if (scale === "quarter") return addMonths(anchor, 12 * by);
  return addDays(anchor, (scale === "day" ? 7 : 28) * by);
}

type Clauses = ReturnType<typeof rangeClauses>;

export function windowClauses(settings: TimelineOptions, window: TimeWindow): { readonly starts: Clauses; readonly spans?: Clauses } {
  const starts = rangeClauses(settings.start, window.from, window.to);
  if (settings.end === "") return { starts };
  const [, before] = rangeClauses(settings.start, window.from, window.to);
  const [after] = rangeClauses(settings.end, window.from, window.to);
  return { starts, spans: [before!, after!] };
}

export interface Item {
  readonly row: DocumentRow;
  readonly start: Date;
  readonly end: Date;
  readonly point: boolean;
  readonly left: number;
  readonly right: number;
}

export interface Lane {
  readonly name: string | undefined;
  readonly rows: readonly (readonly Item[])[];
}

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
