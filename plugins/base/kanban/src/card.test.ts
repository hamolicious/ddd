import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import { DEFAULT_CARD, excerpt, fieldText, parseCard, serializeCard } from "./card.js";

describe("what a card shows", () => {
  it("is the title by default, and reads and writes a readable list", () => {
    expect(parseCard("")).toEqual(DEFAULT_CARD);
    const items = parseCard("title, fm.status ,!content,fm.status,bogus");
    expect(items).toEqual([{ kind: "title" }, { kind: "field", field: "fm.status" }, { kind: "content", hidden: true }]);
    expect(serializeCard(items)).toBe("title,fm.status,!content");
  });

  it("never shows nothing: a list with every item hidden is the default", () => {
    expect(parseCard("!title,!content")).toEqual(DEFAULT_CARD);
  });

  it("prints a property's value, and the note's words", () => {
    const row = { fm: { status: "doing", tags: ["a", "b"] } } as unknown as DocumentRow;
    expect(fieldText(row, "fm.tags")).toBe("a, b");
    expect(fieldText(row, "fm.missing")).toBe("");
    expect(excerpt("---\ntitle: x\n---\n# Heading\n\n- [ ] **do** the [thing](doc://1)\n![](x.png)\n")).toBe("Heading do the thing");
    expect(excerpt("---\ntitle: x\n---\n" + "word ".repeat(100), 20)).toBe("word word word word…");
  });
});
