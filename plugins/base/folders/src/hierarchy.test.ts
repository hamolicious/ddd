/**
 * The hierarchy the tree draws, and the list writes a move makes. The repairs are what
 * the lists can say that a tree cannot — two parents, a loop, an id nobody has — and each
 * one has a test, because a tree widget would only ever show the symptom.
 */

import { describe, expect, it } from "vitest";

import {
  ancestorsOf,
  buildHierarchy,
  descendantCount,
  isWithin,
  planMove,
  readChildren,
  titlePath,
  type NoteRow,
} from "./hierarchy.js";

const note = (id: string, children: readonly string[] = [], title = id.toUpperCase()): NoteRow => ({
  id,
  title,
  children,
});

describe("readChildren", () => {
  it("reads the section's list, strings only, de-duplicated", () => {
    expect(readChildren({ folders: { children: ["a", "b", "a", 3, " c "] } })).toEqual(["a", "b", "c"]);
  });

  it("is empty for anything that is not a list", () => {
    expect(readChildren(undefined)).toEqual([]);
    expect(readChildren({})).toEqual([]);
    expect(readChildren({ folders: { children: "a" } })).toEqual([]);
    expect(readChildren({ folders: { children: null } })).toEqual([]);
    expect(readChildren({ folders: [] })).toEqual([]);
  });
});

describe("buildHierarchy", () => {
  it("puts listed notes under their parent, in list order", () => {
    const tree = buildHierarchy([note("p", ["b", "a"]), note("a"), note("b"), note("loose")]);
    expect(tree.childrenOf.get("p")).toEqual(["b", "a"]);
    expect(tree.parentOf.get("a")).toBe("p");
    expect(tree.roots).toEqual(["loose", "p"]);
  });

  it("skips ids it does not know, without forgetting them", () => {
    const tree = buildHierarchy([note("p", ["gone", "a"]), note("a")]);
    expect(tree.childrenOf.get("p")).toEqual(["a"]);
    expect(tree.notes.get("p")?.children).toEqual(["gone", "a"]);
  });

  it("gives a note two lists claim to the parent with the smaller id", () => {
    const tree = buildHierarchy([note("z", ["a"]), note("m", ["a"]), note("a")]);
    expect(tree.parentOf.get("a")).toBe("m");
    expect(tree.childrenOf.get("z")).toBeUndefined();
  });

  it("ignores a note listing itself", () => {
    const tree = buildHierarchy([note("a", ["a"])]);
    expect(tree.roots).toEqual(["a"]);
    expect(tree.childrenOf.get("a")).toBeUndefined();
  });

  it("cuts a loop at its smallest id, so every note is still drawn", () => {
    const tree = buildHierarchy([note("b", ["c"]), note("c", ["b"]), note("x")]);
    expect(tree.roots).toEqual(["b", "x"]);
    expect(tree.parentOf.get("c")).toBe("b");
    expect(tree.parentOf.has("b")).toBe(false);
  });

  it("cuts a loop hanging below a real root too", () => {
    // r → a, and a ↔ b: `b` claims `a` first (smaller id), which makes a loop; cutting it
    // gives `a` to `r`, the reachable note that also lists it, rather than to the root.
    const tree = buildHierarchy([note("r", ["a"]), note("a", ["b"]), note("b", ["a"])]);
    expect(tree.parentOf.get("a")).toBe("r");
    expect(tree.parentOf.get("b")).toBe("a");
    expect(tree.roots).toEqual(["r"]);
  });
});

describe("walking the hierarchy", () => {
  const tree = buildHierarchy([
    note("home", ["lists"], "Home"),
    note("lists", ["groceries"], "Lists"),
    note("groceries", [], "Groceries"),
  ]);

  it("lists ancestors nearest first", () => {
    expect(ancestorsOf(tree, "groceries")).toEqual(["lists", "home"]);
    expect(ancestorsOf(tree, "home")).toEqual([]);
  });

  it("knows what is inside what", () => {
    expect(isWithin(tree, "groceries", "home")).toBe(true);
    expect(isWithin(tree, "home", "home")).toBe(true);
    expect(isWithin(tree, "home", "groceries")).toBe(false);
  });

  it("spells a note's place as titles from the root", () => {
    expect(titlePath(tree, "groceries")).toEqual(["Home", "Lists", "Groceries"]);
  });

  it("counts everything below a note", () => {
    expect(descendantCount(tree, "home")).toBe(2);
    expect(descendantCount(tree, "groceries")).toBe(0);
  });
});

describe("planMove", () => {
  const rows = [note("p", ["a", "b", "c"]), note("q", ["d"]), note("a"), note("b"), note("c"), note("d"), note("r")];
  const tree = buildHierarchy(rows);

  it("writes the new parent first, then takes the note out of the old one", () => {
    expect(planMove(tree, "d", "p")).toEqual([
      { note: "p", action: "push", id: "d" },
      { note: "q", action: "remove", id: "d" },
    ]);
  });

  it("inserts before the named child", () => {
    expect(planMove(tree, "d", "p", "b")).toEqual([
      { note: "p", action: "insert", id: "d", index: 1 },
      { note: "q", action: "remove", id: "d" },
    ]);
  });

  it("to the root is only the removal", () => {
    expect(planMove(tree, "a", "")).toEqual([{ note: "p", action: "remove", id: "a" }]);
  });

  it("from the root is only the addition", () => {
    expect(planMove(tree, "r", "q")).toEqual([{ note: "q", action: "push", id: "r" }]);
  });

  it("reorders within a parent as a remove and an insert", () => {
    expect(planMove(tree, "c", "p", "a")).toEqual([
      { note: "p", action: "remove", id: "c" },
      { note: "p", action: "insert", id: "c", index: 0 },
    ]);
    expect(planMove(tree, "a", "p")).toEqual([
      { note: "p", action: "remove", id: "a" },
      { note: "p", action: "push", id: "a" },
    ]);
  });

  it("writes nothing when the note is already there", () => {
    expect(planMove(tree, "a", "p", "b")).toEqual([]);
    expect(planMove(tree, "c", "p")).toEqual([]);
    expect(planMove(tree, "r", "")).toEqual([]);
  });

  it("counts an insert's place past ids the tree skips", () => {
    const withGhost = buildHierarchy([note("p", ["ghost", "a", "b"]), note("a"), note("b"), note("x")]);
    expect(planMove(withGhost, "x", "p", "b")).toEqual([{ note: "p", action: "insert", id: "x", index: 2 }]);
  });

  it("clears every other list that names the note", () => {
    const doubled = buildHierarchy([note("m", ["a"]), note("z", ["a"]), note("a"), note("t")]);
    expect(planMove(doubled, "a", "t")).toEqual([
      { note: "t", action: "push", id: "a" },
      { note: "m", action: "remove", id: "a" },
      { note: "z", action: "remove", id: "a" },
    ]);
    // Staying put still repairs the stray copy.
    expect(planMove(doubled, "a", "m")).toEqual([
      { note: "m", action: "remove", id: "a" },
      { note: "m", action: "push", id: "a" },
      { note: "z", action: "remove", id: "a" },
    ]);
  });

  it("refuses a note into itself or anything inside it", () => {
    const nested = buildHierarchy([note("a", ["b"]), note("b")]);
    expect(() => planMove(nested, "a", "a")).toThrow(/inside itself/);
    expect(() => planMove(nested, "a", "b")).toThrow(/inside itself/);
  });
});
