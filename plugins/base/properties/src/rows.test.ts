import { describe, expect, it } from "vitest";

import {
  PREFERRED_KEY_ORDER,
  formatScalar,
  inferKind,
  isDateKey,
  isIsoDateLike,
  joinDateValue,
  keyProblem,
  parseListInput,
  parseScalarInput,
  rowsFromFm,
  splitDateValue,
} from "./rows.js";

describe("isIsoDateLike", () => {
  it("accepts the two canonical shapes", () => {
    expect(isIsoDateLike("2026-09-24")).toBe(true);
    expect(isIsoDateLike("2026-09-24T08:30:00.000Z")).toBe(true);
  });

  it("accepts the looser forms the core normalizes", () => {
    expect(isIsoDateLike("2026-09-24T08:30")).toBe(true);
    expect(isIsoDateLike("2026-09-24 08:30:00")).toBe(true);
    expect(isIsoDateLike("2026-09-24t08:30:00+02:00")).toBe(true);
    expect(isIsoDateLike("2026-09-24T08:30:00+0200")).toBe(true);
    expect(isIsoDateLike("2026-09-24T08:30:00.123456789Z")).toBe(true);
  });

  it("enforces calendar validity, like the core does", () => {
    expect(isIsoDateLike("2026-02-30")).toBe(false);
    expect(isIsoDateLike("2026-13-01")).toBe(false);
    expect(isIsoDateLike("2026-00-10")).toBe(false);
    expect(isIsoDateLike("2024-02-29")).toBe(true); // leap year
    expect(isIsoDateLike("2100-02-29")).toBe(false); // not a leap year
    expect(isIsoDateLike("2026-09-24T25:00:00Z")).toBe(false);
  });

  it("rejects everything that is not a date string", () => {
    expect(isIsoDateLike("tomorrow")).toBe(false);
    expect(isIsoDateLike("24/09/2026")).toBe(false);
    expect(isIsoDateLike(20260924)).toBe(false);
    expect(isIsoDateLike(undefined)).toBe(false);
    expect(isIsoDateLike(null)).toBe(false);
  });
});

describe("inferKind", () => {
  it("types the scalars", () => {
    expect(inferKind("title", "Groceries")).toBe("string");
    expect(inferKind("count", 3)).toBe("number");
    expect(inferKind("ratio", 1.5)).toBe("number");
    expect(inferKind("done", true)).toBe("boolean");
    expect(inferKind("owner", null)).toBe("null");
    expect(inferKind("missing", undefined)).toBe("null");
  });

  it("types collections", () => {
    expect(inferKind("tags", ["work", "home"])).toBe("array");
    expect(inferKind("tags", [])).toBe("array");
    expect(inferKind("meta", { a: 1 })).toBe("map");
  });

  it("types a date from its value", () => {
    expect(inferKind("whenever", "2026-09-24")).toBe("date");
    expect(inferKind("whenever", "2026-09-24T08:00:00.000Z")).toBe("date");
  });

  it("types a date from its key, so an empty one still gets a picker", () => {
    expect(inferKind("due", null)).toBe("date");
    expect(inferKind("start_date", undefined)).toBe("date");
    expect(inferKind("reviewed_at", "")).toBe("date");
    expect(isDateKey("due")).toBe(true);
    expect(isDateKey("updated")).toBe(true);
    expect(isDateKey("duedate")).toBe(false);
  });

  it("does not call a non-date number on a date key a date", () => {
    expect(inferKind("date", 2026)).toBe("number");
  });
});

describe("rowsFromFm", () => {
  it("puts the well-known keys first, then sorts alphabetically", () => {
    const rows = rowsFromFm({
      zebra: 1,
      tags: ["a"],
      apple: 2,
      title: "T",
      path: "home",
    });
    expect(rows.map((row) => row.key)).toEqual(["title", "path", "tags", "apple", "zebra"]);
  });

  it("keeps the preferred order exactly as declared", () => {
    const fm = Object.fromEntries([...PREFERRED_KEY_ORDER].reverse().map((key) => [key, "x"]));
    expect(rowsFromFm(fm).map((row) => row.key)).toEqual([...PREFERRED_KEY_ORDER]);
  });

  it("carries the inferred kind", () => {
    const rows = rowsFromFm({ done: false, due: "2026-09-24", tags: [] });
    expect(rows.map((row) => [row.key, row.kind])).toEqual([
      // `due` and `tags` are preferred keys, in that order; `done` is not.
      ["due", "date"],
      ["tags", "array"],
      ["done", "boolean"],
    ]);
  });

  it("is empty for a document with no frontmatter", () => {
    expect(rowsFromFm(undefined)).toEqual([]);
    expect(rowsFromFm({})).toEqual([]);
  });
});

describe("parseScalarInput", () => {
  it("reads booleans the way the core's YAML subset does", () => {
    for (const text of ["true", "True", "TRUE"]) expect(parseScalarInput(text)).toBe(true);
    for (const text of ["false", "False", "FALSE"]) expect(parseScalarInput(text)).toBe(false);
    expect(parseScalarInput("yes")).toBe("yes");
    expect(parseScalarInput("on")).toBe("on");
  });

  it("reads nulls", () => {
    for (const text of ["", "   ", "null", "Null", "NULL", "~"]) {
      expect(parseScalarInput(text)).toBeNull();
    }
  });

  it("reads numbers", () => {
    expect(parseScalarInput("3")).toBe(3);
    expect(parseScalarInput("-7")).toBe(-7);
    expect(parseScalarInput("1.5")).toBe(1.5);
    expect(parseScalarInput("1e3")).toBe(1000);
    expect(parseScalarInput(".5")).toBe(0.5);
  });

  it("keeps a number too large to represent as the user's text", () => {
    expect(parseScalarInput("123456789012345678901")).toBe("123456789012345678901");
  });

  it("treats quoting as the escape hatch for a string", () => {
    expect(parseScalarInput('"12"')).toBe("12");
    expect(parseScalarInput('"true"')).toBe("true");
    expect(parseScalarInput("'it''s'")).toBe("it's");
    expect(parseScalarInput('""')).toBe("");
  });

  it("leaves anything else a trimmed string", () => {
    expect(parseScalarInput("  Groceries  ")).toBe("Groceries");
    expect(parseScalarInput("2026-09-24")).toBe("2026-09-24");
    expect(parseScalarInput("1.2.3")).toBe("1.2.3");
  });
});

describe("formatScalar", () => {
  it("round-trips through parseScalarInput for scalars", () => {
    for (const value of ["Groceries", 3, 1.5, true, false]) {
      expect(parseScalarInput(formatScalar(value))).toBe(value);
    }
  });

  it("shows nothing for null and undefined", () => {
    expect(formatScalar(null)).toBe("");
    expect(formatScalar(undefined)).toBe("");
  });

  it("joins a list for a text control", () => {
    expect(formatScalar(["work", "home"])).toBe("work, home");
  });

  it("falls back to JSON for a map", () => {
    expect(formatScalar({ a: 1 })).toBe('{"a":1}');
  });
});

describe("parseListInput", () => {
  it("splits on commas and types each item", () => {
    expect(parseListInput("work, home, 3, true")).toEqual(["work", "home", 3, true]);
  });

  it("respects quotes", () => {
    expect(parseListInput('a, "b, c", d')).toEqual(["a", "b, c", "d"]);
  });

  it("respects nesting", () => {
    expect(parseListInput("a, [b, c], d")).toEqual(["a", "[b, c]", "d"]);
  });

  it("drops empty items rather than writing nulls", () => {
    expect(parseListInput("a, , b,")).toEqual(["a", "b"]);
    expect(parseListInput("")).toEqual([]);
    expect(parseListInput("   ")).toEqual([]);
  });
});

describe("the date picker's halves", () => {
  it("splits a date-only value with no time", () => {
    expect(splitDateValue("2026-09-24")).toEqual({ date: "2026-09-24" });
  });

  it("splits a datetime into date and HH:MM", () => {
    const parts = splitDateValue("2026-09-24T08:30:00.000Z");
    expect(parts.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(parts.time).toMatch(/^\d{2}:\d{2}$/);
  });

  it("has no date for a value that is not one", () => {
    expect(splitDateValue("tomorrow")).toEqual({ date: "" });
    expect(splitDateValue(undefined)).toEqual({ date: "" });
    expect(splitDateValue(42)).toEqual({ date: "" });
  });

  it("stores a date-only value verbatim — canonical already, no timezone involved", () => {
    expect(joinDateValue("2026-09-24")).toBe("2026-09-24");
    expect(joinDateValue("2026-09-24", "")).toBe("2026-09-24");
  });

  it("stores a datetime in the canonical UTC shape", () => {
    const stored = joinDateValue("2026-09-24", "08:30");
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/);
    expect(isIsoDateLike(stored)).toBe(true);
  });

  it("round-trips a wall-clock time through split and join", () => {
    const stored = joinDateValue("2026-09-24", "08:30");
    expect(splitDateValue(stored)).toEqual({ date: "2026-09-24", time: "08:30" });
  });

  it("refuses to invent a value from junk", () => {
    expect(joinDateValue("not a date", "08:30")).toBe("not a date");
    expect(joinDateValue("2026-09-24", "midnight")).toBe("2026-09-24");
  });
});

describe("keyProblem", () => {
  it("accepts a conforming key", () => {
    expect(keyProblem("due_date")).toBeUndefined();
    expect(keyProblem("a-1")).toBeUndefined();
    expect(keyProblem("x".repeat(64))).toBeUndefined();
  });

  it("refuses a key the core would drop from `fm`", () => {
    expect(keyProblem("")).toBeDefined();
    expect(keyProblem("   ")).toBeDefined();
    expect(keyProblem("with space")).toBeDefined();
    expect(keyProblem("café")).toBeDefined();
    expect(keyProblem("x".repeat(65))).toBeDefined();
  });

  it("refuses a duplicate", () => {
    expect(keyProblem("title", ["title", "path"])).toMatch(/already set/);
    expect(keyProblem("tags", ["title", "path"])).toBeUndefined();
  });
});
