/**
 * The render model: what rows the tree draws, in what order, at what depth.
 *
 * These are the rules a reader would otherwise have to infer from a component — above
 * all the one the owner asked for in those words: **"notes with no folder just sit in
 * root"**, which is the first test below and the reason a document is a row here at all.
 */

import { describe, expect, it } from "vitest";

import { buildFileTree, ancestorsOf } from "./tree.js";
import type { PathRow } from "./path.js";

const doc = (id: string, title: string, path?: unknown): PathRow => ({
  id,
  title,
  fm: path === undefined ? {} : { path },
});

const keys = (rows: readonly { key: string }[]): readonly string[] => rows.map((row) => row.key);

describe("buildFileTree", () => {
  it("puts a document with no path at the root, beside the top-level folders", () => {
    const tree = buildFileTree([doc("1", "Loose note"), doc("2", "Filed", "home")]);
    expect(keys(tree.rows)).toEqual(["f:home", "d:2", "d:1"]);
    expect(tree.rows.map((row) => row.depth)).toEqual([0, 1, 0]);
    expect(tree.rootDocuments).toBe(1);
  });

  it("sorts folders before documents, and each by name then title", () => {
    const tree = buildFileTree([
      doc("1", "Zebra"),
      doc("2", "Alpha"),
      doc("3", "in beta", "beta"),
      doc("4", "in alpha", "alpha"),
    ]);
    expect(keys(tree.rows)).toEqual(["f:alpha", "d:4", "f:beta", "d:3", "d:2", "d:1"]);
  });

  it("orders deterministically when the collator calls two names equal", () => {
    const one = buildFileTree([doc("1", "x", "Home"), doc("2", "y", "home")]);
    const other = buildFileTree([doc("2", "y", "home"), doc("1", "x", "Home")]);
    expect(keys(one.rows)).toEqual(keys(other.rows));
    // Case-sensitive: two folders, not one (SPEC §6.5).
    expect(one.rows.filter((row) => row.kind === "folder")).toHaveLength(2);
  });

  it("counts the subtree on a folder row and hides what is collapsed", () => {
    const rows = [doc("1", "a", "work"), doc("2", "b", "work/2026"), doc("3", "c", "work/2026")];
    const open = buildFileTree(rows);
    expect(keys(open.rows)).toEqual(["f:work", "f:work/2026", "d:2", "d:3", "d:1"]);

    const shut = buildFileTree(rows, { collapsed: new Set(["work"]) });
    expect(keys(shut.rows)).toEqual(["f:work"]);
    const folder = shut.rows[0];
    expect(folder?.kind === "folder" && folder.documents).toBe(3);
    expect(folder?.kind === "folder" && folder.expanded).toBe(false);
  });

  it("is expanded by default: the negative is what gets stored", () => {
    const tree = buildFileTree([doc("1", "a", "deep/nest")]);
    expect(keys(tree.rows)).toEqual(["f:deep", "f:deep/nest", "d:1"]);
  });

  it("shows a folder that holds nothing yet, and marks it", () => {
    const tree = buildFileTree([], { extraFolders: ["ideas/2027"] });
    expect(keys(tree.rows)).toEqual(["f:ideas", "f:ideas/2027"]);
    expect(tree.rows.every((row) => row.kind === "folder" && row.tracked)).toBe(true);
    // An implied ancestor of a tracked folder is itself empty, so it is marked too.
    const leaf = tree.rows[1];
    expect(leaf?.kind === "folder" && leaf.expandable).toBe(false);
  });

  it("stops marking a tracked folder once a document is in it", () => {
    const tree = buildFileTree([doc("1", "a", "ideas/2027")], { extraFolders: ["ideas/2027"] });
    expect(tree.rows.some((row) => row.kind === "folder" && row.tracked)).toBe(false);
  });

  it("caps the documents drawn in one folder and says how many are left", () => {
    const rows = Array.from({ length: 7 }, (_, index) => doc(`${index}`, `doc ${index}`, "big"));
    const tree = buildFileTree(rows, { leafLimit: 3 });
    expect(keys(tree.rows)).toEqual(["f:big", "d:0", "d:1", "d:2", "m:big"]);
    const more = tree.rows[4];
    expect(more?.kind === "more" && more.hidden).toBe(4);
  });

  it("draws the revealed document past the cap, and counts it out of the rest", () => {
    const rows = Array.from({ length: 7 }, (_, index) => doc(`${index}`, `doc ${index}`, "big"));
    const tree = buildFileTree(rows, { leafLimit: 3, reveal: "5" });
    expect(keys(tree.rows)).toEqual(["f:big", "d:0", "d:1", "d:2", "d:5", "m:big"]);
    const more = tree.rows[5];
    expect(more?.kind === "more" && more.hidden).toBe(3);
  });

  it("caps root documents the same way", () => {
    const rows = Array.from({ length: 4 }, (_, index) => doc(`${index}`, `doc ${index}`));
    const tree = buildFileTree(rows, { leafLimit: 2 });
    expect(keys(tree.rows)).toEqual(["d:0", "d:1", "m:"]);
  });

  it("titles an untitled row rather than drawing an empty one", () => {
    const tree = buildFileTree([{ id: "1", fm: {} }]);
    const row = tree.rows[0];
    expect(row?.kind === "document" && row.title).toBe("Untitled");
  });

  it("handles an empty workspace", () => {
    const tree = buildFileTree([]);
    expect(tree.rows).toEqual([]);
    expect(tree.folders).toEqual([]);
  });
});

describe("ancestorsOf", () => {
  it("lists what has to be open for a path to be on screen", () => {
    expect(ancestorsOf("a/b/c")).toEqual(["a", "a/b"]);
    expect(ancestorsOf("a")).toEqual([]);
    expect(ancestorsOf("")).toEqual([]);
  });
});

describe("the user's folder order", () => {
  const rows = [
    { id: "1", title: "a", fm: { path: "alpha" } },
    { id: "2", title: "b", fm: { path: "beta" } },
    { id: "3", title: "c", fm: { path: "gamma" } },
    { id: "4", title: "d", fm: { path: "beta/inner" } },
  ];
  const folderNames = (order?: readonly string[]): string[] =>
    buildFileTree(rows, { ...(order ? { order } : {}), collapsed: new Set(["beta"]) })
      .rows.filter((row) => row.kind === "folder")
      .map((row) => (row.kind === "folder" ? row.path : ""));

  it("puts listed folders first, in list order, and the rest after by name", () => {
    expect(folderNames()).toEqual(["alpha", "beta", "gamma"]);
    expect(folderNames(["gamma"])).toEqual(["gamma", "alpha", "beta"]);
    expect(folderNames(["gamma", "alpha", "beta"])).toEqual(["gamma", "alpha", "beta"]);
  });

  it("reports each parent's children in draw order", () => {
    const tree = buildFileTree(rows, { order: ["beta", "gamma"] });
    expect(tree.children.get("")).toEqual(["beta", "gamma", "alpha"]);
    expect(tree.children.get("beta")).toEqual(["beta/inner"]);
  });
});
