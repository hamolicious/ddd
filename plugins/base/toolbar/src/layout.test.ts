import { describe, expect, it } from "vitest";

import {
  EMPTY_ARRANGEMENT,
  arrange,
  defaultSeat,
  move,
  readArrangement,
  settingsKey,
  toggleHidden,
  type Arrangement,
  type Placeable,
  type Seated,
} from "./layout.js";

const ids = (seats: Seated<Placeable>) =>
  Object.fromEntries(Object.entries(seats).map(([seat, list]) => [seat, (list ?? []).map((item) => item.id)]));
const same = (item: Placeable): Placeable => item;

// In registry order, as the toolbar hands them over: the bell before the sync pill.
const items: Placeable[] = [
  { id: "settings", side: "end" },
  { id: "admin", side: "end" },
  { id: "bell", side: "end", mobile: { bar: "top" } },
  { id: "sync", side: "end", mobile: { bar: "top" } },
  { id: "status", bar: "bottom" },
  { id: "custom" },
];

describe("defaultSeat", () => {
  it("puts an item in the header on desktop unless it asks for the footer", () => {
    expect(defaultSeat("desktop", { id: "a" })).toBe("top-start");
    expect(defaultSeat("desktop", { id: "a", side: "end" })).toBe("top-end");
    expect(defaultSeat("desktop", { id: "a", bar: "bottom", side: "end" })).toBe("bottom-end");
  });

  it("puts an item in the bottom toolbar on a phone unless it asks for the top", () => {
    expect(defaultSeat("mobile", { id: "a", side: "end" })).toBe("bottom");
    expect(defaultSeat("mobile", { id: "a", bar: "top" })).toBe("bottom");
    expect(defaultSeat("mobile", { id: "a", side: "end", mobile: { bar: "top" } })).toBe("top-end");
    expect(defaultSeat("mobile", { id: "a", side: "end", mobile: { bar: "top", side: "start" } })).toBe("top-start");
  });
});

describe("arrange", () => {
  it("falls back to each item's placement, keeping the given order within a seat", () => {
    expect(ids(arrange(items, same, "desktop", EMPTY_ARRANGEMENT))).toEqual({
      "top-start": ["custom"],
      "top-end": ["settings", "admin", "bell", "sync"],
      "bottom-start": ["status"],
      "bottom-end": [],
    });
    expect(ids(arrange(items, same, "mobile", EMPTY_ARRANGEMENT))).toEqual({
      "top-start": [],
      "top-end": ["bell", "sync"],
      bottom: ["settings", "admin", "status", "custom"],
    });
  });

  it("does not reorder unarranged items by any hint of their own", () => {
    // The registry already sorted by `order`; `arrange` keeps whatever order it is
    // handed rather than sorting a second time.
    const hinted = [
      { id: "late", side: "end", order: 900 },
      { id: "early", side: "end", order: 1 },
    ] as const;
    expect(ids(arrange(hinted, same, "desktop", EMPTY_ARRANGEMENT))["top-end"]).toEqual(["late", "early"]);
  });

  it("puts arranged items first, in the stored order, across seats and bars", () => {
    const arranged = arrange(items, same, "desktop", {
      seats: { "top-start": ["sync"], "top-end": ["bell", "settings"], "bottom-end": ["admin"] },
      hidden: [],
    });
    expect(ids(arranged)).toEqual({
      "top-start": ["sync", "custom"],
      "top-end": ["bell", "settings"],
      "bottom-start": ["status"],
      "bottom-end": ["admin"],
    });
  });

  it("ignores seats the profile does not have", () => {
    // `bottom` is the phone's; on desktop the item goes to its own default seat.
    const arranged = arrange(items, same, "desktop", { seats: { bottom: ["custom"] }, hidden: [] });
    expect(ids(arranged)["top-start"]).toEqual(["custom"]);
  });

  it("skips ids of items that no longer exist", () => {
    const arranged = arrange(items, same, "desktop", {
      seats: { "top-start": ["gone"], "top-end": ["gone", "admin"] },
      hidden: [],
    });
    expect(ids(arranged)["top-end"]?.[0]).toBe("admin");
  });
});

describe("move", () => {
  const current: Arrangement = { seats: { "top-start": ["a", "b"], "top-end": ["c", "d"] }, hidden: ["c"] };

  it("swaps with a neighbour and stops at the edges", () => {
    expect(move(current, "d", { delta: -1 })).toEqual({
      ...current,
      seats: { ...current.seats, "top-end": ["d", "c"] },
    });
    expect(move(current, "a", { delta: -1 })).toEqual(current);
  });

  it("moves to the end of another seat, top to bottom included", () => {
    expect(move(current, "a", { to: "top-end" })).toEqual({
      ...current,
      seats: { "top-start": ["b"], "top-end": ["c", "d", "a"] },
    });
    expect(move(current, "a", { to: "bottom-start" })).toEqual({
      ...current,
      seats: { "top-start": ["b"], "top-end": ["c", "d"], "bottom-start": ["a"] },
    });
  });
});

describe("toggleHidden", () => {
  it("hides a shown item and shows a hidden one, leaving its place alone", () => {
    const current: Arrangement = { seats: { "top-start": ["a"], "top-end": ["b"] }, hidden: [] };
    const hidden = toggleHidden(current, "b");
    expect(hidden).toEqual({ ...current, hidden: ["b"] });
    expect(toggleHidden(hidden, "b")).toEqual(current);
  });
});

describe("readArrangement", () => {
  it("reads one key per seat of the profile, prefixed with the profile", () => {
    expect(settingsKey("mobile", "bottom")).toBe("mobile-bottom");
    const stored: Record<string, unknown> = { "mobile-bottom": ["a"], "mobile-hidden": ["b"], "desktop-top-start": ["c"] };
    expect(readArrangement("mobile", (key) => stored[key])).toEqual({
      seats: { "top-start": [], "top-end": [], bottom: ["a"] },
      hidden: ["b"],
    });
  });

  it("ignores anything that is not a list of strings", () => {
    const stored: Record<string, unknown> = { "desktop-top-start": ["a", 3, "b"], "desktop-top-end": "nope" };
    expect(readArrangement("desktop", (key) => stored[key])).toEqual({
      seats: { "top-start": ["a", "b"], "top-end": [], "bottom-start": [], "bottom-end": [] },
      hidden: [],
    });
  });
});
