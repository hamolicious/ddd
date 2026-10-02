import { describe, expect, it } from "vitest";

import { columnsFor, rowWindow } from "./virtual.js";

describe("rowWindow", () => {
  it("draws the rows in view and the overscan either side", () => {
    expect(rowWindow(400, 400, 40, 1000, 2)).toEqual({ first: 8, end: 22 });
  });

  it("stops at the top and the bottom", () => {
    expect(rowWindow(0, 400, 40, 1000, 3)).toEqual({ first: 0, end: 13 });
    expect(rowWindow(39_600, 400, 40, 1000, 3)).toEqual({ first: 987, end: 1000 });
  });

  it("counts a partly visible row", () => {
    expect(rowWindow(20, 100, 40, 1000, 0)).toEqual({ first: 0, end: 3 });
  });

  it("draws nothing for an empty grid, and survives a scroll past the end", () => {
    expect(rowWindow(0, 400, 40, 0)).toEqual({ first: 0, end: 0 });
    expect(rowWindow(1e6, 400, 40, 10, 0)).toEqual({ first: 10, end: 10 });
  });
});

describe("columnsFor", () => {
  it("fits whole cells, and never fewer than one", () => {
    expect(columnsFor(400, 40)).toBe(10);
    expect(columnsFor(419, 40)).toBe(10);
    expect(columnsFor(10, 40)).toBe(1);
    expect(columnsFor(0, 40)).toBe(1);
  });
});
