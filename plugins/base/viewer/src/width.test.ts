import { describe, expect, it } from "vitest";

import { columnClasses, isFullWidth } from "./width.js";

describe("full-width", () => {
  it("is on only for a boolean true", () => {
    expect(isFullWidth({ "full-width": true })).toBe(true);
    expect(isFullWidth({ "full-width": false })).toBe(false);
    expect(isFullWidth({ "full-width": "true" })).toBe(false);
    expect(isFullWidth({})).toBe(false);
    expect(isFullWidth(undefined)).toBe(false);
  });

  it("drops the measure and shrinks the gutters to 15px", () => {
    expect(columnClasses(true)).toBe("viewer:max-w-none viewer:px-[15px]");
    expect(columnClasses(false)).toContain("viewer:max-w-[72ch]");
  });
});
