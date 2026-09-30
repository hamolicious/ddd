import { describe, expect, it } from "vitest";

import { lastItem, linkedId } from "./FmSelect.js";

describe("lastItem", () => {
  it("is the whole text without a comma", () => {
    expect(lastItem("wor")).toEqual({ before: "", item: "wor" });
  });

  it("is what follows the last comma, keeping the space before it", () => {
    expect(lastItem("work, ho")).toEqual({ before: "work, ", item: "ho" });
    expect(lastItem("work,ho")).toEqual({ before: "work,", item: "ho" });
  });

  it("is empty right after a comma", () => {
    expect(lastItem("work, home, ")).toEqual({ before: "work, home, ", item: "" });
  });
});

describe("linkedId", () => {
  it("is the id a doc:// link names", () => {
    expect(linkedId("doc://abc")).toBe("abc");
  });

  it("is undefined for anything else", () => {
    expect(linkedId("abc")).toBeUndefined();
    expect(linkedId("doc://")).toBeUndefined();
  });
});
