/**
 * The path arithmetic behind every drag: what gets spliced, and what does not.
 *
 * Each test is one rule a user can hit by accident with a mouse — a folder dropped on
 * its own child, a name that already exists in the destination, a document dropped back
 * where it started — and the answer to each is fixed here rather than in a drop handler.
 */

import { describe, expect, it } from "vitest";

import { documentsUnder, planDocumentMove, planFolderMove } from "./moves.js";
import { isRecursiveRename, renameTarget, reparentTarget, type PathRow } from "./path.js";

const row = (id: string, path?: unknown): PathRow => ({
  id,
  fm: path === undefined ? {} : { path },
});

const rows: readonly PathRow[] = [
  row("root-doc"),
  row("a1", "a"),
  row("a2", "a/inner"),
  row("b1", "b"),
  row("b2", "b/notes"),
  row("ab", "ab"),
];

describe("reparentTarget", () => {
  it("keeps the name and takes the new parent", () => {
    expect(reparentTarget("home/lists", "archive")).toBe("archive/lists");
    expect(reparentTarget("home/lists", "")).toBe("lists");
    expect(reparentTarget("home", "archive/2026")).toBe("archive/2026/home");
  });

  it("merges into a folder of the same name rather than inventing a second one", () => {
    // Two `b/notes` cannot exist: a folder is a path prefix, so the drop merges them.
    expect(reparentTarget("a/notes", "b")).toBe("b/notes");
  });

  it("normalizes both ends", () => {
    expect(reparentTarget(" home / lists ", "/archive//")).toBe("archive/lists");
  });
});

describe("renameTarget", () => {
  it("replaces the last segment and keeps the parent", () => {
    expect(renameTarget("home/lists", "shopping")).toBe("home/shopping");
    expect(renameTarget("home", "house")).toBe("house");
  });

  it("accepts a name with separators in it, which is how a rename also moves", () => {
    expect(renameTarget("home/lists", "archive/2026")).toBe("home/archive/2026");
  });

  it("refuses to rename the root", () => {
    expect(renameTarget("", "anything")).toBe("");
  });
});

describe("planFolderMove", () => {
  it("moves the folder and everything under it, and nothing else", () => {
    expect(planFolderMove(rows, "a", "c")).toEqual([
      { id: "a1", from: "a", next: "c" },
      { id: "a2", from: "a/inner", next: "c/inner" },
    ]);
  });

  it("leaves a sibling with a shared prefix alone", () => {
    // `ab` starts with `a`; the prefix test is on whole segments.
    expect(planFolderMove(rows, "a", "c").some((entry) => entry.id === "ab")).toBe(false);
  });

  it("plans a re-parent as the rename it is", () => {
    expect(planFolderMove(rows, "a", reparentTarget("a", "b"))).toEqual([
      { id: "a1", from: "a", next: "b/a" },
      { id: "a2", from: "a/inner", next: "b/a/inner" },
    ]);
  });

  it("empties a folder to the root, which is a removed key rather than a value", () => {
    // `next: ""` is the signal: the `path` line goes away entirely (SPEC §3.3).
    expect(planFolderMove(rows, "a", "")).toEqual([
      { id: "a1", from: "a", next: "" },
      { id: "a2", from: "a/inner", next: "inner" },
    ]);
  });

  it("merges a collision instead of failing, and leaves the documents already there alone", () => {
    const plan = planFolderMove(rows, "a", "b/notes");
    expect(plan).toEqual([
      { id: "a1", from: "a", next: "b/notes" },
      { id: "a2", from: "a/inner", next: "b/notes/inner" },
    ]);
    expect(plan.some((entry) => entry.id === "b2")).toBe(false);
  });

  it("plans nothing when the destination is where the folder already is", () => {
    expect(planFolderMove(rows, "a", "a")).toEqual([]);
    expect(planFolderMove(rows, "a", reparentTarget("a", ""))).toEqual([]);
  });

  it("never plans the root away", () => {
    expect(planFolderMove(rows, "", "somewhere")).toEqual([]);
  });

  it("is resumable: re-planning after a partial run only moves what is left", () => {
    // Half the splices landed; the projection now says so. The second plan is the rest.
    const halfMoved: readonly PathRow[] = [row("a1", "c"), row("a2", "a/inner")];
    expect(planFolderMove(halfMoved, "a", "c")).toEqual([
      { id: "a2", from: "a/inner", next: "c/inner" },
    ]);
  });

  it("pairs with the recursion guard rather than clamping a nonsense move", () => {
    expect(isRecursiveRename("a", reparentTarget("a", "a/inner"))).toBe(true);
    expect(isRecursiveRename("a", reparentTarget("a", "b"))).toBe(false);
  });
});

describe("documentsUnder", () => {
  it("is the delete flow's subject: the folder and everything below it", () => {
    expect(documentsUnder(rows, "a")).toEqual(["a1", "a2"]);
    expect(documentsUnder(rows, "b")).toEqual(["b1", "b2"]);
    expect(documentsUnder(rows, "empty")).toEqual([]);
  });

  it("never claims the whole workspace for the root", () => {
    expect(documentsUnder(rows, "")).toEqual([]);
  });
});

describe("planDocumentMove", () => {
  it("reports no change rather than a splice that writes the same value", () => {
    expect(planDocumentMove("home", "home")).toBeUndefined();
    expect(planDocumentMove(undefined, "")).toBeUndefined();
    expect(planDocumentMove("/home//", "home")).toBeUndefined();
  });

  it("returns the normalized destination, and an empty string for the root", () => {
    expect(planDocumentMove("home", "archive/2026")).toBe("archive/2026");
    expect(planDocumentMove("home", "")).toBe("");
  });
});
