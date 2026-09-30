import { describe, expect, it } from "vitest";

import { PAGE_SIZE, limitFor, remaining, showingText } from "./pagination.js";

describe("paging the list", () => {
  it("grows the limit a page at a time, never below one page", () => {
    expect(limitFor(1)).toBe(PAGE_SIZE);
    expect(limitFor(3)).toBe(3 * PAGE_SIZE);
    expect(limitFor(0)).toBe(PAGE_SIZE);
  });

  it("counts what is left, never below none", () => {
    expect(remaining(50, 62)).toBe(12);
    expect(remaining(70, 62)).toBe(0);
  });

  it("always says the real total", () => {
    expect(showingText(50, 1_000_000)).toBe(`Showing 50 of ${(1_000_000).toLocaleString()}`);
    expect(showingText(12, 12)).toBe("12 documents");
    expect(showingText(1, 1)).toBe("1 document");
  });
});
