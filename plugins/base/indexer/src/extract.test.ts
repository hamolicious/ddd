import { describe, expect, it } from "vitest";

import { docIdOf, extract, flattenFm } from "./extract.js";
import { row } from "./rows.test-util.js";

describe("extract — connections", () => {
  it("reads links, embeds, autolinks and reference definitions, counting repeats", () => {
    const text = [
      "See [the list](doc://A) and [again](doc:A#part).",
      "![](doc://B)",
      "<doc://C>",
      "[ref]: doc://D",
      "[nested [brackets]](doc://E \"title\")",
    ].join("\n");
    const refs = extract(row("X", text)).references;
    expect(refs).toEqual([
      { id: "A", kind: "link", count: 2 },
      { id: "B", kind: "embed", count: 1 },
      { id: "C", kind: "link", count: 1 },
      { id: "D", kind: "link", count: 1 },
      { id: "E", kind: "link", count: 1 },
    ]);
  });

  it("skips code, frontmatter text, %%% sections and self-references", () => {
    const text = [
      "---",
      "title: X",
      "---",
      "`[inline](doc://A)` and [self](doc://X)",
      "```md",
      "[fenced](doc://B)",
      "```",
      "[real](doc://C)",
      "",
      "%%% other",
      "ref: doc://D",
      "%%%",
      "",
    ].join("\n");
    expect(extract(row("X", text, { title: "X" })).references.map((r) => r.id)).toEqual(["C"]);
  });

  it("reads doc:// values in frontmatter, lists and nested maps included, by key", () => {
    const fm = { parent: "doc://P", related: ["doc://Q", "plain", "doc:R"], project: { lead: "doc://S" } };
    expect(extract(row("X", "", fm)).references).toEqual([
      { id: "P", kind: "frontmatter", key: "parent", count: 1 },
      { id: "Q", kind: "frontmatter", key: "related", count: 1 },
      { id: "R", kind: "frontmatter", key: "related", count: 1 },
      { id: "S", kind: "frontmatter", key: "project.lead", count: 1 },
    ]);
  });

  it("gives Trash nothing but its count", () => {
    const data = extract(row("X", "[a](doc://A)\n- [ ] t", { tag: "a" }, { deleted: true }));
    expect(data.references).toEqual([]);
    expect(data.fields).toEqual([]);
    expect(data.tasks).toEqual({ open: 0, done: 0, other: 0 });
  });
});

describe("extract — content", () => {
  it("counts tasks by marker, outside code", () => {
    const text = ["- [ ] a", "* [x] b", "1. [X] c", "- [/] d", "```", "- [ ] no", "```", "not [ ] a task"].join("\n");
    expect(extract(row("X", text)).tasks).toEqual({ open: 1, done: 2, other: 1 });
  });

  it("counts body words and distinct attachments", () => {
    const f1 = "01J0000000000000000000000A";
    const f2 = "01J0000000000000000000000B";
    const text = `---\ntitle: Not counted here\n---\none two  three\n![a](attachment://${f1}) [b](attachment:${f2}) ![c](attachment://${f1}) ![d](attachment://waiting-1a2b3c4d)\n`;
    const data = extract(row("X", text, { title: "Not counted here" }));
    expect(data.words).toBe(7);
    expect(data.attachments).toEqual([f1, f2]);
  });

  it("normalizes the folder and spots machine-owned documents", () => {
    expect(extract(row("X", "", { path: " a//b/./ " })).folder).toBe("a/b");
    expect(extract(row("X", "", { path: ".settings" })).machine).toBe(true);
  });
});

describe("flattenFm", () => {
  it("lists every key, a map and then its keys dotted", () => {
    expect(flattenFm({ a: 1, m: { b: { c: true } }, l: [1] }).map(([key]) => key)).toEqual(["a", "m", "m.b", "m.b.c", "l"]);
  });
});

describe("docIdOf", () => {
  it.each([
    ["doc://01J", "01J"],
    ["doc:01J", "01J"],
    ["doc://01J#h", "01J"],
    ["doc://01J/x?y", "01J"],
    ["doc://", null],
    ["https://x", null],
  ])("%s → %s", (input, expected) => {
    expect(docIdOf(input)).toBe(expected);
  });
});
