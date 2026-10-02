import { describe, expect, it } from "vitest";

import { LINE_PARAM, lineFromPath } from "./line.js";

describe("lineFromPath", () => {
  it("reads a 1-based line out of the query", () => {
    expect(lineFromPath("/doc/01J8Z?line=42")).toBe(42);
    expect(lineFromPath("/doc/01J8Z?line=1")).toBe(1);
    expect(lineFromPath("/doc/01J8Z?mode=edit&line=7")).toBe(7);
    expect(lineFromPath("/doc/01J8Z?line=7&mode=edit")).toBe(7);
  });

  it("has no opinion when there is no query, or no `line` in it", () => {
    expect(lineFromPath("/doc/01J8Z")).toBeUndefined();
    expect(lineFromPath("/")).toBeUndefined();
    expect(lineFromPath("")).toBeUndefined();
    expect(lineFromPath("/doc/01J8Z?q=cake")).toBeUndefined();
  });

  it("refuses anything that is not a positive integer, rather than guessing line 1", () => {
    for (const raw of ["0", "-3", "abc", "", "1.5", "1e3", " 4", "0x4", "+4"]) {
      expect(`${raw} → ${String(lineFromPath(`/doc/x?line=${raw}`))}`).toBe(`${raw} → undefined`);
    }
  });

  it("refuses a line beyond the safe-integer range", () => {
    expect(lineFromPath("/doc/x?line=99999999999999999999")).toBeUndefined();
  });

  it("names the parameter once, so the producer and the consumer cannot drift apart", () => {
    expect(LINE_PARAM).toBe("line");
  });
});
