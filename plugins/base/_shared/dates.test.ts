import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import { addDays, daysBetween, dateOf, isoDay, rangeClauses, startOfWeek } from "./dates.js";

const row = (fm: DocumentRow["fm"], created = "2026-09-01T10:00:00Z"): DocumentRow =>
  ({ fm, created_at: created, updated_at: created }) as DocumentRow;

describe("dates out of documents", () => {
  it("reads a date-only frontmatter value as that local day", () => {
    const date = dateOf(row({ date: "2026-09-23" }), "fm.date");
    expect(date && isoDay(date)).toBe("2026-09-23");
    expect(date?.getHours()).toBe(0);
  });

  it("reads nested keys and the fixed roots", () => {
    expect(dateOf(row({ project: { due: "2026-10-01" } }), "fm.project.due") && true).toBe(true);
    expect(dateOf(row({}), "created_at")?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
  });

  it("leaves out what is not a date", () => {
    expect(dateOf(row({ date: "2026-02-30" }), "fm.date")).toBeUndefined();
    expect(dateOf(row({ date: "soon" }), "fm.date")).toBeUndefined();
    expect(dateOf(row({}), "fm.date")).toBeUndefined();
  });

  it("does day arithmetic by the calendar", () => {
    expect(isoDay(startOfWeek(new Date(2026, 8, 30)))).toBe("2026-09-28");
    expect(daysBetween(new Date(2026, 2, 1), new Date(2026, 3, 1))).toBe(31);
    expect(isoDay(addDays(new Date(2026, 11, 31), 1))).toBe("2027-01-01");
  });

  it("narrows a search to a range, a day wider each side", () => {
    expect(rangeClauses("fm.date", new Date(2026, 8, 1), new Date(2026, 9, 1)).map((clause) => clause.value)).toEqual([
      "2026-08-31",
      "2026-10-02",
    ]);
  });
});
