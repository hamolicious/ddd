import { describe, expect, it } from "vitest";

import { contentOverflows } from "./pane.js";

describe("contentOverflows", () => {
  it("is false for a mode that fills the pane and scrolls itself", () => {
    expect(contentOverflows(700, 700, 0)).toBe(false);
  });

  it("is true for content taller than the pane", () => {
    expect(contentOverflows(2400, 700, 0)).toBe(true);
  });

  it("leaves the spacer out, so adding it never decides on its own", () => {
    expect(contentOverflows(780, 700, 80)).toBe(false);
    expect(contentOverflows(2480, 700, 80)).toBe(true);
  });
});
