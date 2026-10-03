import { describe, expect, it } from "vitest";

import { keyboardCovers } from "./keyboard.js";

describe("keyboardCovers", () => {
  it("is false before any height is known", () => {
    expect(keyboardCovers(400, 0)).toBe(false);
  });

  it("ignores small changes such as a collapsing address bar", () => {
    expect(keyboardCovers(780, 844)).toBe(false);
  });

  it("is true once the visible height drops by a keyboard's worth", () => {
    expect(keyboardCovers(420, 844)).toBe(true);
  });
});
