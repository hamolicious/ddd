import { describe, expect, it } from "vitest";

import { RECENT_LIMIT, parseRecent, pushRecent, recencyIndex } from "./recent.js";

describe("recent commands", () => {
  it("moves a run command to the front without duplicating it", () => {
    expect(pushRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(pushRecent([], "a")).toEqual(["a"]);
  });

  it("keeps at most the last hundred", () => {
    let recent: readonly string[] = [];
    for (let index = 0; index < RECENT_LIMIT + 20; index++) recent = pushRecent(recent, `c${index}`);
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent[0]).toBe(`c${RECENT_LIMIT + 19}`);
  });

  it("reads back only a list of strings", () => {
    expect(parseRecent('["a","b","a",3]')).toEqual(["a", "b"]);
    expect(parseRecent("{}")).toEqual([]);
    expect(parseRecent("not json")).toEqual([]);
    expect(parseRecent(null)).toEqual([]);
  });

  it("indexes by position", () => {
    expect(recencyIndex(["x", "y"]).get("y")).toBe(1);
  });
});
