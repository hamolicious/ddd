import { describe, expect, it } from "vitest";

import { basicPath, isAdvanced } from "./mode.js";

describe("documents page mode", () => {
  it("is basic with no query or only text", () => {
    expect(isAdvanced("")).toBe(false);
    expect(isAdvanced("q=meeting")).toBe(false);
  });

  it("is advanced when asked or when the link carries filters, sort or table options", () => {
    expect(isAdvanced("advanced=1")).toBe(true);
    expect(isAdvanced("q=a&where=x")).toBe(true);
    expect(isAdvanced("sort=title:asc")).toBe(true);
    expect(isAdvanced("t.rows=200")).toBe(true);
  });

  it("keeps only the text in a basic path", () => {
    expect(basicPath("")).toBe("/");
    expect(basicPath("  ")).toBe("/");
    expect(basicPath(" teh qick ")).toBe("/?q=teh+qick");
  });
});
