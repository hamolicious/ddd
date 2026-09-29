/**
 * The render model: what rows the tree draws, in what order, at what depth.
 */

import { describe, expect, it } from "vitest";

import { buildHierarchy, type NoteRow } from "./hierarchy.js";
import { buildFileTree, type FileTreeOptions } from "./tree.js";

const note = (id: string, title: string, children: readonly string[] = []): NoteRow => ({ id, title, children });

const keys = (rows: readonly { key: string }[]): readonly string[] => rows.map((row) => row.key);
const draw = (rows: readonly NoteRow[], options?: FileTreeOptions) => buildFileTree(buildHierarchy(rows), options);

describe("buildFileTree", () => {
  it("draws notes nobody lists at the root, and children under their parent", () => {
    const tree = draw([note("h", "Home", ["l"]), note("l", "Lists"), note("x", "Loose")]);
    expect(keys(tree.rows)).toEqual(["n:h", "n:l", "n:x"]);
    expect(tree.rows.map((row) => row.depth)).toEqual([0, 1, 0]);
  });

  it("keeps a parent's list order and sorts the root by title", () => {
    const tree = draw([note("p", "Parent", ["z", "a"]), note("z", "Zebra"), note("a", "Alpha"), note("b", "Beta")]);
    expect(keys(tree.rows)).toEqual(["n:b", "n:p", "n:z", "n:a"]);
  });

  it("orders deterministically when the collator calls two titles equal", () => {
    const one = draw([note("1", "Home"), note("2", "home")]);
    const other = draw([note("2", "home"), note("1", "Home")]);
    expect(keys(one.rows)).toEqual(keys(other.rows));
  });

  it("marks what can open, counts what is below, and hides what is collapsed", () => {
    const rows = [note("w", "Work", ["y"]), note("y", "2026", ["a", "b"]), note("a", "a"), note("b", "b")];
    expect(keys(draw(rows).rows)).toEqual(["n:w", "n:y", "n:a", "n:b"]);
    const shut = draw(rows, { collapsed: new Set(["w"]) });
    expect(keys(shut.rows)).toEqual(["n:w"]);
    const row = shut.rows[0];
    expect(row?.kind === "note" && row.descendants).toBe(3);
    expect(row?.kind === "note" && row.expandable && !row.expanded).toBe(true);
    const leaf = draw(rows).rows[2];
    expect(leaf?.kind === "note" && leaf.expandable).toBe(false);
  });

  it("draws every child, however many a note holds", () => {
    const ids = Array.from({ length: 400 }, (_, index) => `${index}`);
    const tree = draw([note("big", "Big", ids), ...ids.map((id) => note(id, `n ${id}`))]);
    expect(tree.rows).toHaveLength(401);
  });

  it("puts root notes in the user's order first, the rest after by title", () => {
    const rows = [note("a", "Alpha"), note("b", "Beta"), note("g", "Gamma")];
    expect(keys(draw(rows, { rootOrder: ["g"] }).rows)).toEqual(["n:g", "n:a", "n:b"]);
    expect(draw(rows, { rootOrder: ["b", "g"] }).siblings.get("")).toEqual(["b", "g", "a"]);
  });

  it("handles an empty workspace", () => {
    expect(draw([]).rows).toEqual([]);
  });
});
