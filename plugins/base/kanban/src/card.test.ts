import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import { DEFAULT_CARD, fieldParts, fieldText, parseCard, serializeCard } from "./card.js";

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

  it("prints a property's value", () => {
    const row = { fm: { status: "doing", tags: ["a", "b"] } } as unknown as DocumentRow;
    expect(fieldText(row, "fm.tags")).toBe("a, b");
    expect(fieldText(row, "fm.missing")).toBe("");
  });

  it("draws a doc:// value, alone or in a list, as the note it points at", () => {
    const row = { fm: { "blocked-by": "doc://01M3W3", related: ["doc://01A", "plain", "doc://not an id"], status: "doing", none: [] } } as unknown as DocumentRow;
    expect(fieldParts(row, "fm.blocked-by")).toEqual([{ kind: "doc", id: "01M3W3" }]);
    expect(fieldParts(row, "fm.related")).toEqual([
      { kind: "doc", id: "01A" },
      { kind: "text", text: "plain" },
      { kind: "text", text: "doc://not an id" },
    ]);
    expect(fieldParts(row, "fm.status")).toEqual([{ kind: "text", text: "doing" }]);
    expect(fieldParts(row, "fm.none")).toEqual([]);
    expect(fieldParts(row, "fm.missing")).toEqual([]);
    expect(fieldText(row, "fm.related")).toBe("doc://01A, plain, doc://not an id");
  });
});
