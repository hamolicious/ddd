import { describe, expect, it } from "vitest";

import { allToRemove, copiesToRemove, type Strategy } from "./cleanup.js";

const copy = (id: string, references: number) => ({ id, references });
const ids = (copies: readonly { readonly id: string }[]) => copies.map((c) => c.id);
// Oldest first, as the server sends them.
const group = [copy("old", 0), copy("mid", 2), copy("new", 1)];

describe("copiesToRemove", () => {
  it.each<[Strategy, string[]]>([
    ["unused", ["old"]],
    ["oldest", ["mid", "new"]],
    ["newest", ["old", "mid"]],
    ["most-used", ["old", "new"]],
  ])("%s", (strategy, expected) => {
    expect(ids(copiesToRemove(group, strategy))).toEqual(expected);
  });

  it("keeps the oldest when no copy is used, under unused", () => {
    expect(ids(copiesToRemove([copy("old", 0), copy("new", 0)], "unused"))).toEqual(["new"]);
  });

  it("breaks a most-used tie towards the oldest", () => {
    expect(ids(copiesToRemove([copy("old", 1), copy("new", 1)], "most-used"))).toEqual(["new"]);
  });

  it("never touches a group of one", () => {
    expect(copiesToRemove([copy("only", 0)], "oldest")).toEqual([]);
  });

  it("collects across groups", () => {
    const groups = [{ copies: group }, { copies: [copy("a", 1), copy("b", 1)] }];
    expect(ids(allToRemove(groups, (g) => g.copies, "unused"))).toEqual(["old"]);
  });
});
