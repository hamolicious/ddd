/**
 * `?line=N`, the deep-link query (`line.ts`).
 *
 * Small enough to look obvious and worth pinning anyway: the parameter arrives from
 * the address bar, from a search result and from whatever a plugin author writes, so
 * "no line" has to be distinguishable from "line 1" in every spelling a person can
 * produce. A parser that read `?line=0` as the first line would scroll a reader
 * somewhere they did not ask to go, every time a link was built with an off-by-one.
 */

import { describe, expect, it } from "vitest";

import { LINE_PARAM, lineFromPath } from "./line.js";

describe("lineFromPath", () => {
  it("reads a 1-based line out of the query", () => {
    expect(lineFromPath("/doc/01J8Z?line=42")).toBe(42);
    expect(lineFromPath("/doc/01J8Z?line=1")).toBe(1);
    // Order and company do not matter — it is a query parameter, not a suffix.
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
    // `search/src/hash.ts` writes this spelling as a literal, deliberately: a plugin
    // may not import another plugin's source, and a URL is the agreed address instead.
    expect(LINE_PARAM).toBe("line");
  });
});
