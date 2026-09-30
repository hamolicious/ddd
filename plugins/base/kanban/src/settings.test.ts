import { describe, expect, it } from "vitest";

import { normalizeColor } from "./ColumnEditor.js";

describe("column colours", () => {
  it("take any hex, short or long, with or without #", () => {
    expect(normalizeColor("#ABCDEF")).toBe("#abcdef");
    expect(normalizeColor("abc")).toBe("#aabbcc");
    expect(normalizeColor("#12345")).toBeUndefined();
    expect(normalizeColor("red")).toBeUndefined();
  });
});
