/**
 * `fm.path` normalization and the derived tree, against SPEC §6.5's row for `folders`:
 * "Tree from `fm.path` (normalized `/` segments, `.`/`..`/empty stripped, case-sensitive,
 * duplicate names allowed — docs are id-addressed)".
 *
 * Every clause of that sentence is one test below, because each one is a decision someone
 * will later mistake for an oversight.
 */

import { describe, expect, it } from "vitest";

import {
  buildTree,
  isRecursiveRename,
  isWithin,
  joinPath,
  nameOf,
  normalizePath,
  parentOf,
  renamedPath,
  segmentsOf,
  type PathRow,
} from "./path.js";

const row = (id: string, path?: unknown): PathRow => ({
  id,
  fm: path === undefined ? {} : { path },
});

describe("normalizePath", () => {
  it("keeps a well-formed path unchanged", () => {
    expect(normalizePath("home/lists")).toBe("home/lists");
  });

  it("strips empty segments", () => {
    expect(normalizePath("/home//lists/")).toBe("home/lists");
    expect(normalizePath("///")).toBe("");
  });

  it("strips `.` and `..` rather than resolving them", () => {
    // Resolving `..` would let a document escape the folder it was dropped into.
    expect(normalizePath("home/../lists")).toBe("home/lists");
    expect(normalizePath("./home/./lists")).toBe("home/lists");
    expect(normalizePath("..")).toBe("");
  });

  it("is case-sensitive: Home and home are two folders", () => {
    expect(normalizePath("Home")).not.toBe(normalizePath("home"));
  });

  it("trims whitespace inside segments", () => {
    expect(normalizePath(" home / lists ")).toBe("home/lists");
    expect(normalizePath("   ")).toBe("");
  });

  it("treats a non-string value as unfiled", () => {
    expect(normalizePath(undefined)).toBe("");
    expect(normalizePath(42)).toBe("");
    expect(normalizePath(["home"])).toBe("");
    expect(normalizePath(null)).toBe("");
  });

  it("is idempotent", () => {
    for (const input of ["/a//b/", "a/../b", " a / b ", "", "..", "a"]) {
      const once = normalizePath(input);
      expect(normalizePath(once)).toBe(once);
    }
  });
});

describe("segments, parents and joins", () => {
  it("splits and rejoins without surprises", () => {
    expect(segmentsOf("a/b/c")).toEqual(["a", "b", "c"]);
    expect(segmentsOf("")).toEqual([]);
    expect(parentOf("a/b/c")).toBe("a/b");
    expect(parentOf("a")).toBe("");
    expect(nameOf("a/b")).toBe("b");
    expect(nameOf("")).toBe("");
    expect(joinPath("home", "lists", "2026")).toBe("home/lists/2026");
    expect(joinPath("home/", "/lists")).toBe("home/lists");
  });

  it("tests containment on whole segments", () => {
    expect(isWithin("home/lists", "home")).toBe(true);
    expect(isWithin("home", "home")).toBe(true);
    expect(isWithin("homework", "home")).toBe(false);
    // Everything is within the unfiled root.
    expect(isWithin("anything", "")).toBe(true);
  });
});

describe("buildTree", () => {
  it("implies ancestors and counts a document in every one of them", () => {
    const tree = buildTree([row("1", "a/b/c")]);
    expect(tree.flat.map((node) => node.path)).toEqual(["a", "a/b", "a/b/c"]);
    expect(tree.flat.map((node) => node.documents)).toEqual([1, 1, 1]);
    expect(tree.flat.map((node) => node.directDocuments)).toEqual([0, 0, 1]);
  });

  it("counts a subtree and its direct children separately", () => {
    const tree = buildTree([row("1", "a"), row("2", "a/b"), row("3", "a/b")]);
    const a = tree.flat.find((node) => node.path === "a");
    const b = tree.flat.find((node) => node.path === "a/b");
    expect(a?.documents).toBe(3);
    expect(a?.directDocuments).toBe(1);
    expect(b?.documents).toBe(2);
    expect(b?.directDocuments).toBe(2);
  });

  it("reports unfiled documents instead of inventing a folder for them", () => {
    const tree = buildTree([row("1"), row("2", ""), row("3", 7), row("4", "a")]);
    expect(tree.unfiled).toBe(3);
    expect(tree.totalDocuments).toBe(4);
    expect(tree.roots.map((node) => node.path)).toEqual(["a"]);
  });

  it("keeps folders that differ only in case as separate rows", () => {
    const tree = buildTree([row("1", "Home"), row("2", "home")]);
    expect(tree.roots).toHaveLength(2);
    expect(tree.roots.map((node) => node.documents)).toEqual([1, 1]);
    // Deterministic order even when the locale collator calls the names equal.
    expect(buildTree([row("2", "home"), row("1", "Home")]).roots.map((node) => node.path)).toEqual(
      tree.roots.map((node) => node.path),
    );
  });

  it("allows duplicate names in different parents", () => {
    const tree = buildTree([row("1", "a/notes"), row("2", "b/notes")]);
    expect(tree.flat.map((node) => node.path)).toEqual(["a", "a/notes", "b", "b/notes"]);
  });

  it("nests depth for aria-level", () => {
    const tree = buildTree([row("1", "a/b/c")]);
    expect(tree.flat.map((node) => node.depth)).toEqual([0, 1, 2]);
  });

  it("handles an empty workspace", () => {
    const tree = buildTree([]);
    expect(tree.roots).toEqual([]);
    expect(tree.unfiled).toBe(0);
  });
});

describe("renamedPath", () => {
  it("rewrites the folder and everything under it", () => {
    expect(renamedPath("home", "home", "house")).toBe("house");
    expect(renamedPath("home/lists", "home", "house")).toBe("house/lists");
    expect(renamedPath("home/lists/2026", "home/lists", "archive")).toBe("archive/2026");
  });

  it("leaves a sibling with a shared prefix alone", () => {
    expect(renamedPath("homework", "home", "house")).toBeUndefined();
  });

  it("leaves unrelated documents alone", () => {
    expect(renamedPath("work", "home", "house")).toBeUndefined();
    expect(renamedPath("", "home", "house")).toBeUndefined();
  });

  it("moves a folder to the top level when the target is empty", () => {
    expect(renamedPath("home/lists", "home", "")).toBe("lists");
  });

  it("reports no change rather than the same path", () => {
    expect(renamedPath("home/lists", "home", "home")).toBeUndefined();
  });

  it("normalizes both ends", () => {
    expect(renamedPath("/home//lists", " home ", "house/")).toBe("house/lists");
  });
});

describe("isRecursiveRename", () => {
  it("refuses moving a folder inside itself", () => {
    expect(isRecursiveRename("home", "home/inner")).toBe(true);
    expect(isRecursiveRename("home", "house")).toBe(false);
    expect(isRecursiveRename("home", "home")).toBe(false);
    expect(isRecursiveRename("home", "homework")).toBe(false);
  });
});
