import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import { isoDay } from "../../_shared/dates.js";
import { calendarOptions, entriesByDay, monthGrid, withCalendar } from "./layout.js";

const note = (id: string, fm: DocumentRow["fm"]): DocumentRow =>
  ({ id, title: id, fm, created_at: "2026-09-10T12:00:00Z", updated_at: "2026-09-10T12:00:00Z" }) as DocumentRow;

describe("the calendar", () => {
  it("shows six weeks from the Monday on or before the first", () => {
    const grid = monthGrid(new Date(2026, 8, 15));
    expect(grid).toHaveLength(42);
    expect(isoDay(grid[0]!)).toBe("2026-08-31");
  });

  it("defaults to the created date, and keeps defaults out of the options", () => {
    expect(calendarOptions({})).toEqual({ date: "created_at", end: "" });
    expect(withCalendar({ date: "created_at", end: "" }, { other: "x", date: "fm.date" })).toEqual({ other: "x" });
    expect(withCalendar({ date: "fm.date", end: "fm.until" }, {})).toEqual({ date: "fm.date", end: "fm.until" });
  });

  it("puts a note on the day of the chosen field", () => {
    const days = entriesByDay([note("a", { date: "2026-09-03" }), note("b", {})], calendarOptions({ date: "fm.date" }), new Date(2026, 8, 1), new Date(2026, 9, 1));
    expect([...days.keys()]).toEqual(["2026-09-03"]);
  });

  it("runs a note across its days up to the end field, clipped to the grid", () => {
    const days = entriesByDay(
      [note("trip", { date: "2026-08-30", until: "2026-09-02" })],
      calendarOptions({ date: "fm.date", end: "fm.until" }),
      new Date(2026, 8, 1),
      new Date(2026, 9, 1),
    );
    expect([...days.keys()]).toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("treats an end before the start as a one-day note", () => {
    const days = entriesByDay(
      [note("x", { date: "2026-09-05", until: "2026-09-01" })],
      calendarOptions({ date: "fm.date", end: "fm.until" }),
      new Date(2026, 8, 1),
      new Date(2026, 9, 1),
    );
    expect([...days.keys()]).toEqual(["2026-09-05"]);
  });
});
