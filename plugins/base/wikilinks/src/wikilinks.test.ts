import { describe, expect, it } from "vitest";

import { linksIn } from "./decorate.js";
import { linkTo, suggest, type Note } from "./suggest.js";

const notes: Note[] = [
  { id: "a", title: "Groceries", folder: "" },
  { id: "b", title: "Weekly groceries plan", folder: "Home" },
  { id: "c", title: "Shopping", folder: "Groceries" },
  { id: "d", title: "Journal", folder: "" },
];

describe("suggest", () => {
  it("opens on [[ and ranks prefix, word, folder", () => {
    const found = suggest("see [[groc", "see [[groc", notes);
    expect(found?.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(found?.replace).toBe(6);
    expect(found?.items[0]?.insert).toBe("[](doc://a)");
  });

  it("embeds on ![[", () => {
    const found = suggest("![[jour", "![[jour", notes);
    expect(found?.embed).toBe(true);
    expect(found?.replace).toBe(7);
    expect(found?.items[0]?.insert).toBe("![](doc://d)");
  });

  it("lists every note for a bare [[, leaving out the note being edited", () => {
    expect(suggest("[[", "[[", notes, "a")?.items.map((item) => item.id)).toEqual(["b", "c", "d"]);
  });

  it("stays shut without [[, in code, and with nothing to offer", () => {
    expect(suggest("[groc", "[groc", notes)).toBeUndefined();
    expect(suggest("`[[groc", "`[[groc", notes)).toBeUndefined();
    expect(suggest("[[groc", "```\n[[groc", notes)).toBeUndefined();
    expect(suggest("[[zzz", "[[zzz", notes)).toBeUndefined();
  });

  it("writes the bare doc:// value in the frontmatter, where nothing embeds", () => {
    const found = suggest("blocked-by: [[groc", "---\nblocked-by: [[groc", notes);
    expect(found?.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(found?.replace).toBe(6);
    expect(found?.items[0]?.insert).toBe("doc://a");
    expect(suggest("related: [a, ![[jour", "---\nrelated: [a, ![[jour", notes)).toMatchObject({ embed: false, replace: 7, items: [{ insert: "doc://d" }] });
    expect(suggest("[[groc", "---\n---\n[[groc", notes)?.items[0]?.insert).toBe("[](doc://a)");
  });
});

describe("linksIn", () => {
  it("finds links, embeds and autolinks", () => {
    expect(linksIn(`x ${linkTo("a", false)} ![t](doc://b) <doc://c> [n](https://x)`)).toEqual([
      { from: 2, id: "a", embed: false },
      { from: 14, id: "b", embed: true },
      { from: 28, id: "c", embed: false },
    ]);
  });

  it("finds a bare doc:// value, as a property holds one", () => {
    expect(linksIn(`---\nparent: doc://a\nrelated: [doc://b, "doc://c"]\n---\n`)).toEqual([
      { from: 12, id: "a", embed: false },
      { from: 30, id: "b", embed: false },
      { from: 40, id: "c", embed: false },
    ]);
  });
});
