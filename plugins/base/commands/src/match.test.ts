import { describe, expect, it } from "vitest";

import { rankMatches, scoreMatch } from "./match.js";

const COMMANDS = [
  { id: "admin.snapshots", title: "Browse snapshots", category: "Admin" },
  { id: "themes.open", title: "Change theme", category: "Appearance" },
  { id: "admin.invites", title: "Create an invite", category: "Admin" },
  { id: "commands.keybindings", title: "Edit keybindings", category: "Commands" },
  { id: "doc-list.new", title: "New document", category: "Documents" },
  { id: "bare", title: "Aardvark" },
];

describe("rankMatches", () => {
  it("groups an unfiltered list by category, then title", () => {
    const order = rankMatches("", COMMANDS).map((entry) => entry.item.id);
    expect(order).toEqual([
      "bare",
      "admin.snapshots",
      "admin.invites",
      "themes.open",
      "commands.keybindings",
      "doc-list.new",
    ]);
  });

  it("still ranks on score first, so a query beats the grouping", () => {
    const order = rankMatches("new doc", COMMANDS).map((entry) => entry.item.id);
    expect(order[0]).toBe("doc-list.new");
  });

  it("opens with the recently run commands first, newest first", () => {
    const recency = new Map([
      ["doc-list.new", 0],
      ["themes.open", 1],
    ]);
    const order = rankMatches("", COMMANDS, recency).map((entry) => entry.item.id);
    expect(order).toEqual(["doc-list.new", "themes.open", "bare", "admin.snapshots", "admin.invites", "commands.keybindings"]);
  });

  it("lets recency break a tie between matches but never beat a better match", () => {
    const tied = [
      { id: "one", title: "Open one" },
      { id: "two", title: "Open two" },
    ];
    expect(rankMatches("open", tied, new Map([["two", 0]]))[0]?.item.id).toBe("two");
    const order = rankMatches("new doc", COMMANDS, new Map([["themes.open", 0]])).map((entry) => entry.item.id);
    expect(order[0]).toBe("doc-list.new");
  });

  it("is stable: the same query gives the same order", () => {
    const once = rankMatches("e", COMMANDS).map((entry) => entry.item.id);
    const again = rankMatches("e", [...COMMANDS].reverse()).map((entry) => entry.item.id);
    expect(again).toEqual(once);
  });
});

describe("scoreMatch", () => {
  it("prefers a title prefix over a scattered subsequence", () => {
    const prefix = scoreMatch("new", { id: "a", title: "New document" });
    const scattered = scoreMatch("new", { id: "b", title: "Rename we wrote" });
    expect(prefix?.score ?? -1).toBeGreaterThan(scattered?.score ?? -1);
  });

  it("falls back to the category-qualified spelling", () => {
    expect(scoreMatch("admin invite", { id: "a", title: "Create an invite" })).toBeUndefined();
    expect(
      scoreMatch("admin invite", { id: "a", title: "Create an invite", category: "Admin" }),
    ).toBeDefined();
  });
});
