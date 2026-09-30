import { describe, expect, it } from "vitest";

import { normalizeColor } from "./ColumnEditor.js";
import { kanbanOptions, withKanban } from "./layout.js";

describe("column colours", () => {
  it("take any hex, short or long, with or without #", () => {
    expect(normalizeColor("#ABCDEF")).toBe("#abcdef");
    expect(normalizeColor("abc")).toBe("#aabbcc");
    expect(normalizeColor("#12345")).toBeUndefined();
    expect(normalizeColor("red")).toBeUndefined();
  });
});

describe("the swimlane field", () => {
  it("is off unless set, kept only when set, and cleared by choosing none", () => {
    expect(kanbanOptions({}).lanes).toBe("");
    expect(kanbanOptions({ lanes: "fm.team" }).lanes).toBe("fm.team");
    expect(withKanban({ ...kanbanOptions({}), lanes: "fm.team" }, { other: "x" })).toEqual({ other: "x", lanes: "fm.team" });
    expect(withKanban({ ...kanbanOptions({ lanes: "fm.team" }), lanes: "" }, { lanes: "fm.team" })).toEqual({});
  });
});
