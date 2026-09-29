import { describe, expect, it } from "vitest";

import { placeAmong, pruneOrder, rankOf } from "./order.js";

describe("root order", () => {
  it("ranks listed notes by position and the rest after", () => {
    expect(rankOf(["b", "a"], "a")).toBe(1);
    expect(rankOf(["b", "a"], "c")).toBe(Number.POSITIVE_INFINITY);
  });

  it("places a note before or after a sibling", () => {
    expect(placeAmong(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(placeAmong(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(placeAmong(["a", "b"], "x", "a", "after")).toEqual(["a", "x", "b"]);
  });

  it("drops notes that are no longer at the root", () => {
    expect(pruneOrder(["a", "gone", "b"], new Set(["a", "b"]))).toEqual(["a", "b"]);
  });
});
