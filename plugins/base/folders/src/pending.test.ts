/**
 * The moves drawn ahead of the projection: the tree shows where a document is going
 * the moment it is dropped, and hands back to the projection as soon as it agrees.
 */

import { describe, expect, it } from "vitest";

import { settledMoves, withPendingPaths } from "./pending.js";
import type { PathRow } from "./path.js";

const row = (id: string, path?: string): PathRow => ({
  id,
  title: id,
  fm: path === undefined ? { title: id } : { title: id, path },
});

describe("withPendingPaths", () => {
  it("draws a moved document in its new folder before the projection has it", () => {
    const rows = [row("doc", "a"), row("other", "a")];
    expect(withPendingPaths(rows, new Map([["doc", "b"]]))).toEqual([row("doc", "b"), row("other", "a")]);
  });

  it("draws a move to root as a document with no path key at all", () => {
    expect(withPendingPaths([row("doc", "a")], new Map([["doc", ""]]))).toEqual([row("doc")]);
  });

  it("returns the projection untouched when nothing is in flight", () => {
    const rows = [row("doc", "a")];
    expect(withPendingPaths(rows, new Map())).toBe(rows);
  });
});

describe("settledMoves", () => {
  it("settles a move once the projection says the same thing", () => {
    const pending = new Map([["doc", "b"]]);
    expect(settledMoves([row("doc", "a")], pending)).toEqual([]);
    expect(settledMoves([row("doc", "b")], pending)).toEqual(["doc"]);
    expect(settledMoves([row("doc", "/b/")], pending)).toEqual(["doc"]);
  });

  it("settles a move to root once the path key is gone", () => {
    expect(settledMoves([row("doc")], new Map([["doc", ""]]))).toEqual(["doc"]);
  });

  it("gives up on a document the projection no longer has", () => {
    expect(settledMoves([], new Map([["doc", "b"]]))).toEqual(["doc"]);
  });
});
