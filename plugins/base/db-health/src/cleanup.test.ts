import { describe, expect, it } from "vitest";

import { allRemovable, removableCopies } from "./cleanup.js";

const copy = (id: string, references: number) => ({ id, references });

describe("removableCopies", () => {
  it("removes every unused copy when another copy is used", () => {
    expect(removableCopies([copy("a", 0), copy("b", 1), copy("c", 0)]).map((c) => c.id)).toEqual(["a", "c"]);
  });

  it("keeps the oldest when no copy is used", () => {
    expect(removableCopies([copy("old", 0), copy("new", 0)]).map((c) => c.id)).toEqual(["new"]);
  });

  it("removes nothing when every copy is used", () => {
    expect(removableCopies([copy("a", 1), copy("b", 2)])).toEqual([]);
  });

  it("collects across groups", () => {
    const groups = [{ copies: [copy("a", 0), copy("b", 1)] }, { copies: [copy("c", 1), copy("d", 1)] }];
    expect(allRemovable(groups, (group) => group.copies).map((c) => c.id)).toEqual(["a"]);
  });
});
