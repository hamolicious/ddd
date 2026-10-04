import { describe, expect, it } from "vitest";

import { compareVersions } from "./versions.js";

describe("compareVersions", () => {
  it("orders versions numerically, a pre-release before its release", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBe(-1);
    expect(compareVersions("v1.2", "1.2.0")).toBe(0);
  });
});
