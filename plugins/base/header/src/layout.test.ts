import { describe, expect, it } from "vitest";

import {
  EMPTY_ARRANGEMENT,
  arrange,
  move,
  readArrangement,
  toggleHidden,
  type Placeable,
} from "./layout.js";

const ids = (seats: Record<"start" | "end", Placeable[]>) => ({
  start: seats.start.map((item) => item.id),
  end: seats.end.map((item) => item.id),
});
const same = (item: Placeable): Placeable => item;

// In registry order, as the header hands them over: the bell before the sync pill.
const items: Placeable[] = [
  { id: "settings", side: "end" },
  { id: "admin", side: "end" },
  { id: "bell", side: "end" },
  { id: "sync", side: "end" },
  { id: "custom" },
];

describe("arrange", () => {
  it("falls back to each item's side, keeping the given order within it", () => {
    expect(ids(arrange(items, same, EMPTY_ARRANGEMENT))).toEqual({
      start: ["custom"],
      end: ["settings", "admin", "bell", "sync"],
    });
  });

  it("does not reorder unarranged items by any hint of their own", () => {
    // The registry already sorted by `order`; `arrange` keeps whatever order it is
    // handed rather than sorting a second time.
    const hinted = [
      { id: "late", side: "end", order: 900 },
      { id: "early", side: "end", order: 1 },
    ] as const;
    expect(ids(arrange(hinted, same, EMPTY_ARRANGEMENT)).end).toEqual(["late", "early"]);
  });

  it("puts arranged items first, in the stored order, across seats", () => {
    const arranged = arrange(items, same, {
      start: ["sync"],
      end: ["bell", "settings"],
      hidden: [],
    });
    expect(ids(arranged)).toEqual({
      start: ["sync", "custom"],
      end: ["bell", "settings", "admin"],
    });
  });

  it("skips ids of items that no longer exist", () => {
    const arranged = arrange(items, same, { start: ["gone"], end: ["gone", "admin"], hidden: [] });
    expect(ids(arranged).end[0]).toBe("admin");
  });
});

describe("move", () => {
  const current = { start: ["a", "b"], end: ["c", "d"], hidden: ["c"] };

  it("swaps with a neighbour and stops at the edges", () => {
    expect(move(current, "d", { delta: -1 })).toEqual({ ...current, end: ["d", "c"] });
    expect(move(current, "a", { delta: -1 })).toEqual(current);
  });

  it("moves to the end of the other seat", () => {
    expect(move(current, "a", { to: "end" })).toEqual({
      ...current,
      start: ["b"],
      end: ["c", "d", "a"],
    });
  });
});

describe("toggleHidden", () => {
  it("hides a shown item and shows a hidden one, leaving its place alone", () => {
    const current = { start: ["a"], end: ["b"], hidden: [] };
    const hidden = toggleHidden(current, "b");
    expect(hidden).toEqual({ start: ["a"], end: ["b"], hidden: ["b"] });
    expect(toggleHidden(hidden, "b")).toEqual(current);
  });
});

describe("readArrangement", () => {
  it("ignores anything that is not a list of strings", () => {
    expect(readArrangement(["a", 3, "b"], "nope", undefined)).toEqual({
      start: ["a", "b"],
      end: [],
      hidden: [],
    });
  });
});
