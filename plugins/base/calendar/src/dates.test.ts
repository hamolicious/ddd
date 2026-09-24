import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import {
  GRID_DAYS,
  ROW_LIMIT,
  addDays,
  compareRows,
  currentMonth,
  dayLabel,
  dayOfValue,
  daysOf,
  isCancelled,
  isImported,
  isDayKey,
  isMonthKey,
  listOf,
  monthGrid,
  monthLabel,
  monthOf,
  monthQuery,
  shiftMonth,
  spanOf,
  timeLabel,
  todayKey,
  weekIndex,
  weekWindow,
  weeksOf,
  windowFilter,
  windowQuery,
} from "./dates.js";

/** A projection row, with only the fields this plugin reads spelled out. */
function row(
  id: string,
  title: string,
  fm: Record<string, unknown>,
  plugins: Record<string, unknown> = {},
): DocumentRow {
  return {
    id,
    title,
    fm: fm as DocumentRow["fm"],
    plugins: plugins as DocumentRow["plugins"],
    fm_parse_error: false,
    materialized_version: "v1",
    created_at: "2026-09-01T00:00:00.000Z",
    created_by: "plugin:calendar",
    updated_at: "2026-09-01T00:00:00.000Z",
    updated_by: "plugin:calendar",
    deleted: false,
    deleted_at: null,
    deleted_by: null,
    purged: false,
  };
}

describe("keys and labels", () => {
  it("recognises the two key shapes and rejects near misses", () => {
    expect(isMonthKey("2026-09")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-9")).toBe(false);
    expect(isMonthKey("2026-09-24")).toBe(false);
    expect(isDayKey("2026-09-24")).toBe(true);
    expect(isDayKey("2026-09-31")).toBe(true); // shape only; 31 September is caught by arithmetic
    expect(isDayKey("2026-09-32")).toBe(false);
    expect(isDayKey("2026-09-24T09:00:00.000Z")).toBe(false);
  });

  it("labels a month and a day for a human", () => {
    expect(monthLabel("2026-09")).toBe("September 2026");
    expect(monthLabel("2026-01")).toBe("January 2026");
    expect(dayLabel("2026-09-24")).toBe("Thu 24 Sep");
  });

  it("derives a month from a day and today from the local clock", () => {
    expect(monthOf("2026-09-24")).toBe("2026-09");
    // Local, deliberately: "today" is a claim about the person looking at the screen.
    const noon = new Date(2026, 8, 24, 12, 0, 0);
    expect(todayKey(noon)).toBe("2026-09-24");
    expect(currentMonth(noon)).toBe("2026-09");
  });
});

describe("arithmetic", () => {
  it("shifts months across year boundaries in both directions", () => {
    expect(shiftMonth("2026-09", 1)).toBe("2026-10");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-01", -13)).toBe("2024-12");
    expect(shiftMonth("2026-06", 18)).toBe("2027-12");
  });

  it("shifts days across months, years and a leap day", () => {
    expect(addDays("2026-09-24", 1)).toBe("2026-09-25");
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });

  it("indexes weekdays Monday-first", () => {
    expect(weekIndex("2026-09-21")).toBe(0); // Monday
    expect(weekIndex("2026-09-24")).toBe(3); // Thursday
    expect(weekIndex("2026-09-27")).toBe(6); // Sunday
  });
});

describe("the grid window", () => {
  it("is always six weeks and starts on the Monday on or before the 1st", () => {
    const grid = monthGrid("2026-09"); // 1 September 2026 is a Tuesday
    expect(grid.start).toBe("2026-08-31");
    expect(grid.days).toHaveLength(GRID_DAYS);
    expect(grid.days[0]).toBe("2026-08-31");
    expect(grid.days[GRID_DAYS - 1]).toBe("2026-10-11");
    expect(grid.endExclusive).toBe("2026-10-12");
  });

  it("keeps its height for a month that begins on a Monday", () => {
    const grid = monthGrid("2026-06"); // 1 June 2026 is a Monday
    expect(grid.start).toBe("2026-06-01");
    expect(grid.days).toHaveLength(GRID_DAYS);
  });

  it("covers February in a leap year without a short week", () => {
    const grid = monthGrid("2024-02");
    expect(grid.days).toHaveLength(GRID_DAYS);
    expect(grid.days).toContain("2024-02-29");
  });
});

describe("the query", () => {
  it("asks for rows whose span intersects the window, not only those inside it", () => {
    const grid = monthGrid("2026-09");
    expect(windowFilter(grid)).toEqual({
      and: [
        { exists: { field: "fm.date" } },
        { cmp: { field: "fm.date", op: "lt", value: { date: "2026-10-12" } } },
        {
          or: [
            { cmp: { field: "fm.date", op: "gte", value: { date: "2026-08-31" } } },
            { cmp: { field: "fm.date-end", op: "gte", value: { date: "2026-08-31" } } },
          ],
        },
      ],
    });
  });

  it("bounds the upper end exclusively, so timed events on the last day survive", () => {
    // The evaluator compares canonical date strings byte-wise (SPEC §4.2), and
    // "2026-10-11T09:00:00.000Z" > "2026-10-11" — an `lte` bound on the last day would drop
    // every timed event on it. This is the assertion that keeps that bug from coming back.
    const grid = monthGrid("2026-09");
    const bound = (windowFilter(grid) as { and: { cmp?: { op: string; value: { date: string } } }[] }).and[1];
    expect(bound?.cmp?.op).toBe("lt");
    expect(bound?.cmp?.value.date).toBe(addDays(grid.days[GRID_DAYS - 1] as string, 1));
  });

  it("sorts ascending by date and carries a bound", () => {
    const query = monthQuery("2026-09");
    expect(query.sort).toEqual([{ field: "fm.date", direction: "asc" }]);
    expect(query.limit).toBe(ROW_LIMIT);
    expect(query.includeDeleted ?? false).toBe(false);
  });

  it("never asks for trashed rows: a deleted event is not on anyone's calendar", () => {
    expect(monthQuery("2026-09").includeDeleted).toBeUndefined();
    expect(windowQuery(weekWindow("2026-09-24")).includeDeleted).toBeUndefined();
  });

  it("builds a Monday-first week window and queries it the same way", () => {
    const week = weekWindow("2026-09-24"); // a Thursday
    expect(week.start).toBe("2026-09-21");
    expect(week.days).toHaveLength(7);
    expect(week.endExclusive).toBe("2026-09-28");
    const query = windowQuery(week);
    expect(query.filter).toEqual(windowFilter(week));
    expect(query.limit).toBe(ROW_LIMIT);
  });

  it("treats a Monday and the Sunday after it as the same week", () => {
    expect(weekWindow("2026-09-21").start).toBe("2026-09-21");
    expect(weekWindow("2026-09-27").start).toBe("2026-09-21");
  });
});

describe("reading a row", () => {
  it("takes the day from the canonical value without converting a zone", () => {
    expect(dayOfValue("2026-09-24")).toBe("2026-09-24");
    expect(dayOfValue("2026-09-24T23:30:00.000Z")).toBe("2026-09-24");
    expect(dayOfValue("2026-09-24T09:00:00Z")).toBe("2026-09-24");
    expect(dayOfValue("someday")).toBeUndefined();
    expect(dayOfValue(42)).toBeUndefined();
    expect(dayOfValue(undefined)).toBeUndefined();
    expect(dayOfValue(null)).toBeUndefined();
  });

  it("shows a clock only for a timed event", () => {
    expect(timeLabel("2026-09-24T09:05:00.000Z")).toBe("09:05");
    expect(timeLabel("2026-09-24")).toBeUndefined();
    expect(timeLabel(null)).toBeUndefined();
  });

  it("spans from date to date-end, and refuses an impossible end", () => {
    expect(spanOf(row("1", "A", { date: "2026-09-24" }))).toEqual({
      start: "2026-09-24",
      end: "2026-09-24",
    });
    expect(spanOf(row("2", "B", { date: "2026-09-24", "date-end": "2026-09-26" }))).toEqual({
      start: "2026-09-24",
      end: "2026-09-26",
    });
    // A human edited the end before the start: the start is what is certainly meant.
    expect(spanOf(row("3", "C", { date: "2026-09-24", "date-end": "2026-09-20" }))).toEqual({
      start: "2026-09-24",
      end: "2026-09-24",
    });
    expect(spanOf(row("4", "D", { path: "notes" }))).toBeUndefined();
  });

  it("recognises imported and cancelled events", () => {
    expect(isImported(row("1", "A", { date: "2026-09-24", source: "ical" }))).toBe(true);
    expect(isImported(row("2", "B", { date: "2026-09-24" }))).toBe(false);
    expect(
      isCancelled(row("3", "C", { date: "2026-09-24" }, { calendar: { status: "cancelled" } })),
    ).toBe(true);
    expect(
      isCancelled(row("4", "D", { date: "2026-09-24" }, { calendar: { status: "confirmed" } })),
    ).toBe(false);
    expect(isCancelled(row("5", "E", { date: "2026-09-24" }))).toBe(false);
  });
});

describe("grouping rows into cells", () => {
  const standup = row("s", "Standup", { date: "2026-09-24T09:00:00.000Z", source: "ical" });
  const review = row("r", "Review", { date: "2026-09-24T08:30:00.000Z" });
  const holiday = row("h", "Holiday", { date: "2026-09-24" });
  const trip = row("t", "Conference", { date: "2026-09-23", "date-end": "2026-09-25" });
  const note = row("n", "Undated note", { path: "notes" });
  const neighbour = row("p", "Last month", { date: "2026-08-31" });

  it("puts every dated document on its day, imported or not", () => {
    const cells = daysOf("2026-09", [standup, review, holiday, note]);
    const day = cells.find((cell) => cell.date === "2026-09-24");
    expect(day?.rows.map((r) => r.id)).toEqual(["h", "r", "s"]);
    // A plain note with a date is a calendar entry: that is the point of a shared field.
    expect(day?.rows.some((r) => !isImported(r))).toBe(true);
    // An undated document is nowhere.
    expect(cells.flatMap((cell) => cell.rows).some((r) => r.id === "n")).toBe(false);
  });

  it("repeats a multi-day row in every cell it covers", () => {
    const cells = daysOf("2026-09", [trip]);
    const covered = cells.filter((cell) => cell.rows.some((r) => r.id === "t")).map((c) => c.date);
    expect(covered).toEqual(["2026-09-23", "2026-09-24", "2026-09-25"]);
  });

  it("clamps a span that starts before the window or ends after it", () => {
    const long = row("l", "Sabbatical", { date: "2020-01-01", "date-end": "2030-01-01" });
    const cells = daysOf("2026-09", [long]);
    // Every one of the 42 cells, and no runaway loop.
    expect(cells.every((cell) => cell.rows.some((r) => r.id === "l"))).toBe(true);
  });

  it("marks the neighbouring months' cells as outside the month", () => {
    const cells = daysOf("2026-09", [neighbour]);
    const first = cells[0];
    expect(first?.date).toBe("2026-08-31");
    expect(first?.inMonth).toBe(false);
    expect(first?.rows.map((r) => r.id)).toEqual(["p"]);
    expect(cells.find((cell) => cell.date === "2026-09-01")?.inMonth).toBe(true);
  });

  it("returns all 42 cells even when nothing is dated", () => {
    const cells = daysOf("2026-09", []);
    expect(cells).toHaveLength(GRID_DAYS);
    expect(cells.every((cell) => cell.rows.length === 0)).toBe(true);
    expect(listOf(cells)).toEqual([]);
  });

  it("orders a day's rows all-day first, then by clock, then by title", () => {
    const later = row("z", "Zeta", { date: "2026-09-24T09:00:00.000Z" });
    const sorted = [standup, review, holiday, later].sort(compareRows);
    expect(sorted.map((r) => r.id)).toEqual(["h", "r", "s", "z"]);
  });

  it("splits the cells into six weeks of seven", () => {
    const weeks = weeksOf(daysOf("2026-09", []));
    expect(weeks).toHaveLength(6);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
  });

  it("lists only the days that have something on them", () => {
    const list = listOf(daysOf("2026-09", [standup, trip]));
    expect(list.map((day) => day.date)).toEqual(["2026-09-23", "2026-09-24", "2026-09-25"]);
  });
});
