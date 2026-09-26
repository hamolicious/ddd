import { describe, expect, it } from "vitest";

import { placeAmong, pruneOrder, rankOf, renameInOrder, withSiblings } from "./order.js";

describe("folder order", () => {
  it("ranks listed folders by position and the rest after", () => {
    expect(rankOf(["b", "a"], "a")).toBe(1);
    expect(rankOf(["b", "a"], "c")).toBe(Number.POSITIVE_INFINITY);
  });

  it("places a folder before or after a sibling", () => {
    expect(placeAmong(["a", "b", "c"], "c", "a", "before")).toEqual(["c", "a", "b"]);
    expect(placeAmong(["a", "b", "c"], "a", "c", "after")).toEqual(["b", "c", "a"]);
    expect(placeAmong(["a", "b"], "x/y", "a", "after")).toEqual(["a", "x/y", "b"]);
  });

  it("rewrites one parent's children and keeps every other entry", () => {
    expect(withSiblings(["p/1", "a", "p/2", "b"], ["b", "a"])).toEqual(["p/1", "p/2", "b", "a"]);
    // A folder that left another parent loses its old entry too.
    expect(withSiblings(["old/x", "a"], ["a", "x"], ["old/x"])).toEqual(["a", "x"]);
  });

  it("carries a renamed folder's entry and its descendants'", () => {
    expect(renameInOrder(["a", "a/b", "ab", "c"], "a", "z")).toEqual(["z", "z/b", "ab", "c"]);
  });

  it("drops folders that no longer exist", () => {
    expect(pruneOrder(["a", "gone", "b"], new Set(["a", "b"]))).toEqual(["a", "b"]);
  });
});
