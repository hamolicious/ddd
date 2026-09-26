/**
 * The typing and display rules for frontmatter values (`fm-display.ts`).
 *
 * The reason the file exists is drift: `viewer` draws the read-mode header from it, and
 * any other plugin that shows `fm` must agree about whether `due` is a date. Every
 * assertion below is therefore about a shared rule, not about anyone's markup.
 */

import { describe, expect, it } from "vitest";

import type { CoreValue } from "@kernel";

import {
  PREFERRED_KEY_ORDER,
  displayRow,
  fmDisplayRows,
  formatDateValue,
  formatScalar,
  inferKind,
  isDateKey,
  isIsoDateLike,
  rowsFromFm,
} from "./fm-display.js";

describe("inferKind", () => {
  it("types the scalars the core's YAML subset produces", () => {
    expect(inferKind("anything", "text")).toBe("string");
    expect(inferKind("anything", 3)).toBe("number");
    expect(inferKind("anything", true)).toBe("boolean");
    expect(inferKind("anything", null)).toBe("null");
    expect(inferKind("anything", undefined)).toBe("null");
    expect(inferKind("tags", ["a", "b"])).toBe("array");
    expect(inferKind("nested", { a: 1 })).toBe("map");
  });

  it("calls a value a date by its shape or by its key", () => {
    expect(inferKind("whenever", "2026-09-23")).toBe("date");
    expect(inferKind("whenever", "2026-09-23T08:00:00.000Z")).toBe("date");
    // …and by the key, so an empty `due` still gets a date control rather than a text
    // box that would write an unsortable string the first time it was used.
    expect(inferKind("due", null)).toBe("date");
    expect(inferKind("created_at", "")).toBe("date");
    expect(isDateKey("start_date")).toBe(true);
    expect(isDateKey("dates")).toBe(false);
  });

  it("refuses a date that is not a date the core would parse", () => {
    // The core rejects `2026-02-30`, so a picker here would silently lose the text.
    expect(isIsoDateLike("2026-02-30")).toBe(false);
    expect(isIsoDateLike("2026-13-01")).toBe(false);
    expect(isIsoDateLike("2026-02-29")).toBe(false); // 2026 is not a leap year…
    expect(isIsoDateLike("2024-02-29")).toBe(true); // …and 2024 is.
    expect(isIsoDateLike("yesterday")).toBe(false);
    expect(isIsoDateLike(20260923)).toBe(false);
    expect(inferKind("note", "2026-02-30")).toBe("string");
  });
});

describe("rowsFromFm", () => {
  it("puts the keys the whole app reads first, then sorts the rest", () => {
    const rows = rowsFromFm({ zeta: 1, tags: ["x"], alpha: 2, title: "T", path: "a/b" });
    expect(rows.map((row) => row.key)).toEqual(["title", "path", "tags", "alpha", "zeta"]);
    expect(PREFERRED_KEY_ORDER.indexOf("title")).toBe(0);
  });

  it("is empty for a document with no frontmatter", () => {
    expect(rowsFromFm(undefined)).toEqual([]);
    expect(rowsFromFm({})).toEqual([]);
    expect(fmDisplayRows(undefined)).toEqual([]);
  });
});

describe("fmDisplayRows", () => {
  it("prints a list as items and keeps the stored form", () => {
    const [row] = fmDisplayRows({ tags: ["home", "urgent"] });
    expect(row?.kind).toBe("array");
    expect(row?.items).toEqual(["home", "urgent"]);
    expect(row?.raw).toBe("home, urgent");
    expect(row?.empty).toBe(false);
  });

  it("prints a boolean for a reader and keeps the stored form", () => {
    const [yes] = fmDisplayRows({ draft: true });
    expect(yes?.text).toBe("Yes");
    expect(yes?.raw).toBe("true");
    const [no] = fmDisplayRows({ draft: false });
    expect(no?.text).toBe("No");
    expect(no?.raw).toBe("false");
    // A `false` is a value, not an absence: the row must not grey itself out.
    expect(no?.empty).toBe(false);
  });

  it("marks a key that is set but holds nothing", () => {
    // Annotated rather than inferred: a bare array literal of three differently-shaped
    // objects widens to a union whose members each carry the *other* two keys as
    // `undefined`, which an index signature of `CoreValue` correctly refuses.
    const cases: readonly Readonly<Record<string, CoreValue>>[] = [
      { due: null },
      { note: "" },
      { tags: [] },
    ];
    for (const fm of cases) {
      const [row] = fmDisplayRows(fm);
      expect(row?.empty, JSON.stringify(fm)).toBe(true);
    }
    // …and a zero is not nothing.
    expect(fmDisplayRows({ count: 0 })[0]?.empty).toBe(false);
    expect(fmDisplayRows({ count: 0 })[0]?.text).toBe("0");
  });

  it("leaves a string alone", () => {
    const [row] = fmDisplayRows({ status: "in progress" });
    expect(row?.text).toBe("in progress");
    expect(row?.raw).toBe("in progress");
  });
});

describe("formatDateValue", () => {
  it("never moves a date-only value across a timezone boundary", () => {
    // The bug this pins: `new Date("2026-09-23")` is UTC midnight, and west of
    // Greenwich `toLocaleDateString` then prints the 22nd — every date-only document
    // in the workspace dated a day early for half the planet. The components are read
    // out of the text and handed to a *local* `Date`, which cannot shift.
    const printed = formatDateValue("2026-09-23");
    expect(printed).toContain("23");
    expect(printed).toContain("2026");
    expect(printed).not.toBe("2026-09-23"); // it really was formatted
  });

  it("formats a datetime with its time", () => {
    const printed = formatDateValue("2026-09-23T08:30:00.000Z");
    expect(printed).toContain("2026");
    expect(printed).toMatch(/\d{1,2}[:.]\d{2}/);
  });

  it("keeps a year below 100 in its own century", () => {
    // `new Date(26, 0, 1)` is **1926**: the multi-argument constructor applies the
    // two-digit-year rule to any year 0–99. `0026-01-01` passes `isIsoDateLike` (four
    // digits, month 1, day 1), so without `setFullYear` the header printed a date the
    // document does not contain — the same failure the `2026-02-30` case below closes
    // for calendar validity.
    expect(formatDateValue("0026-01-01")).not.toContain("1926");
    expect(formatDateValue("0026-01-01")).toContain("26");
    expect(formatDateValue("0099-12-31")).not.toContain("1999");
    // And the ordinary years are untouched by the fix.
    expect(formatDateValue("2026-09-23")).toContain("2026");
    expect(formatDateValue("1926-01-01")).toContain("1926");
  });

  it("returns anything it cannot read unchanged", () => {
    // The header shows what the document says rather than inventing a reading of it.
    expect(formatDateValue("sometime next week")).toBe("sometime next week");
    expect(formatDateValue("2026-02-30")).toBe("2026-02-30");
  });

  it("is what a date row prints, with the stored value kept beside it", () => {
    const row = displayRow({ key: "date", value: "2026-09-23", kind: "date" });
    expect(row.raw).toBe("2026-09-23");
    expect(row.text).toBe(formatDateValue("2026-09-23"));
  });
});

describe("formatScalar", () => {
  it("is the round-trippable form, not the pretty one", () => {
    // A control that writes the value back re-parses this text, so a date has to come
    // out as the text the document holds.
    expect(formatScalar("2026-09-23")).toBe("2026-09-23");
    expect(formatScalar(true)).toBe("true");
    expect(formatScalar(null)).toBe("");
    expect(formatScalar(undefined)).toBe("");
    expect(formatScalar(["a", 1])).toBe("a, 1");
    expect(formatScalar({ a: 1 })).toBe('{"a":1}');
  });
});
