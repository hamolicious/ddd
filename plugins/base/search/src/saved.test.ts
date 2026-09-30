import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import { SAVED_SEARCH_KEY, isSavedSearch, savedSearchNoteText, savedSearchOf, savedSearchTitle } from "./saved.js";

const row = (fm: DocumentRow["fm"]): DocumentRow => ({ fm }) as DocumentRow;

describe("saved searches", () => {
  it("recognises a note by its key", () => {
    expect(isSavedSearch(row({ [SAVED_SEARCH_KEY]: "q=milk" }))).toBe(true);
    expect(savedSearchOf(row({ [SAVED_SEARCH_KEY]: "q=milk" }))).toBe("q=milk");
    expect(isSavedSearch(row({ [SAVED_SEARCH_KEY]: 3 }))).toBe(false);
    expect(isSavedSearch(row({}))).toBe(false);
  });

  it("titles a note by what was searched", () => {
    expect(savedSearchTitle(" milk ")).toBe("milk");
    expect(savedSearchTitle("")).toBe("Saved search");
  });

  it("writes the key and the type into the frontmatter, quoted when it must be", () => {
    const text = savedSearchNoteText("a: b", "q=milk", ["table"]);
    expect(text).toContain("title: 'a: b'\n");
    expect(text).toContain(`${SAVED_SEARCH_KEY}: q=milk\n`);
    expect(text).toContain("type: table\n");
  });
});
