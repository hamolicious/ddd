/**
 * The empty-folder list, which exists only to shrink.
 *
 * The invariant every test here defends: **a folder that holds a document is never in
 * this list.** `fm.path` is the truth (SPEC §6.5), and a second record of the same fact
 * is a thing that can disagree with it.
 */

import { describe, expect, it } from "vitest";

import {
  TRACKED_LIMIT,
  mergeTracked,
  pruneTracked,
  readTracked,
  renameTracked,
  sameTracked,
  withFolder,
  withoutFolder,
} from "./empty-folders.js";
import type { PathRow } from "./path.js";

const row = (id: string, path?: unknown): PathRow => ({
  id,
  fm: path === undefined ? {} : { path },
});

describe("readTracked", () => {
  it("normalizes, de-duplicates and keeps insertion order", () => {
    expect(readTracked(["/b//", "a", "b", " a "])).toEqual(["b", "a"]);
  });

  it("survives anything a human could leave in the settings document", () => {
    expect(readTracked(undefined)).toEqual([]);
    expect(readTracked(null)).toEqual([]);
    expect(readTracked(42)).toEqual([]);
    expect(readTracked([7, "", "..", "ok"])).toEqual(["ok"]);
    // A flow sequence that lost its brackets reads as one comma-joined string.
    expect(readTracked("a,b")).toEqual(["a", "b"]);
  });
});

describe("withFolder / withoutFolder", () => {
  it("adds once and is idempotent", () => {
    expect(withFolder([], "a/b")).toEqual(["a/b"]);
    expect(withFolder(["a/b"], " a/b ")).toEqual(["a/b"]);
    expect(withFolder(["a"], "")).toEqual(["a"]);
  });

  it("drops the oldest entry past the cap", () => {
    const full = Array.from({ length: TRACKED_LIMIT }, (_, index) => `f${index}`);
    const next = withFolder(full, "newest");
    expect(next).toHaveLength(TRACKED_LIMIT);
    expect(next[0]).toBe("f1");
    expect(next[next.length - 1]).toBe("newest");
  });

  it("forgets a folder and its descendants, and nothing that merely shares a prefix", () => {
    expect(withoutFolder(["a", "a/b", "ab", "b"], "a")).toEqual(["ab", "b"]);
  });
});

describe("pruneTracked", () => {
  it("drops an entry the moment a document is in it", () => {
    expect(pruneTracked(["a", "b"], [row("1", "a")])).toEqual(["b"]);
  });

  it("drops an ancestor too: a document at a/b/c makes a/b real", () => {
    expect(pruneTracked(["a/b"], [row("1", "a/b/c")])).toEqual([]);
  });

  it("keeps an entry a document merely shares a prefix with", () => {
    expect(pruneTracked(["home"], [row("1", "homework")])).toEqual(["home"]);
  });

  it("keeps an empty parent when only its empty child is tracked", () => {
    // Both are the user's; deleting the child must not take the parent with it, which
    // is why redundant ancestors are *not* pruned.
    expect(pruneTracked(["a", "a/b"], [])).toEqual(["a", "a/b"]);
  });

  it("returns the same array when nothing changed, so no settings write happens", () => {
    const tracked = ["a"];
    expect(pruneTracked(tracked, [row("1", "b")])).toBe(tracked);
    expect(pruneTracked([], [row("1", "b")])).toEqual([]);
  });
});

describe("renameTracked", () => {
  it("follows a renamed prefix", () => {
    expect(renameTracked(["a", "a/b", "c"], "a", "z")).toEqual(["z", "z/b", "c"]);
  });

  it("merges two empty folders that end up with the same path", () => {
    expect(renameTracked(["a", "b"], "a", "b")).toEqual(["b"]);
  });

  it("lifts an entry to the root, where it stops being a folder at all", () => {
    expect(renameTracked(["a", "a/b"], "a", "")).toEqual(["b"]);
  });
});

describe("sameTracked", () => {
  it("compares entries and order", () => {
    expect(sameTracked(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameTracked(["a", "b"], ["b", "a"])).toBe(false);
    expect(sameTracked(["a"], ["a", "b"])).toBe(false);
  });
});

describe("mergeTracked", () => {
  // The failure it exists for: the whole list is one settings key, so two devices that
  // each create a folder write `emptyFolders:` concurrently and the settings host keeps
  // one line (SPEC §3.3, last occurrence wins). The folder made on the losing device is
  // gone from both trees, with no error anywhere — the opposite of the stale entry this
  // module is otherwise written around, and the one that costs a user something.
  it("folds an entry the stored list lost back in", () => {
    expect(mergeTracked(["beta"], ["alpha"])).toEqual(["beta", "alpha"]);
  });

  it("changes nothing when the stored list already has it", () => {
    const stored = ["alpha", "beta"];
    expect(mergeTracked(stored, ["alpha"])).toBe(stored);
  });

  it("is order-stable and idempotent, so two devices converge on one list", () => {
    const first = mergeTracked(["beta"], ["alpha"]);
    expect(mergeTracked(first, ["alpha"])).toEqual(first);
    expect(mergeTracked(first, ["beta"])).toEqual(first);
    // Both devices end up with the union whichever of them writes it.
    expect(mergeTracked(["alpha"], ["beta"])).toEqual(["alpha", "beta"]);
  });

  it("stays inside the cap", () => {
    const stored = Array.from({ length: TRACKED_LIMIT }, (_, index) => `f${String(index)}`);
    const merged = mergeTracked(stored, ["late"]);
    expect(merged).toHaveLength(TRACKED_LIMIT);
    expect(merged.at(-1)).toBe("late");
    expect(merged).not.toContain("f0");
  });

  it("ignores entries that normalize away", () => {
    expect(mergeTracked(["a"], ["", "  ", "."])).toEqual(["a"]);
  });
});
