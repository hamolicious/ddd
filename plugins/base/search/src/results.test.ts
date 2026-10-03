import { describe, expect, it } from "vitest";

import { fakeSearch } from "../../_shared/fake-search.test-util.js";
import { EXCLUDE_MACHINE_DOCUMENTS } from "../../_shared/machine-docs.js";

import { resolveSearch, searchQuery, sortTokens } from "./results.js";
import { EMPTY_SPEC, filterOf } from "./spec.js";

const rowsFor = (ids: readonly string[]) => fakeSearch(() => ids.map((id) => ({ id, title: id, fm: {} })));

describe("a search as a kernel.search query", () => {
  it("sorts by the search's sort, and breaks best-match ties by last updated", () => {
    expect(sortTokens({ field: "title", direction: "asc" })).toEqual(["title"]);
    expect(sortTokens({ field: "fm.due", direction: "desc" })).toEqual(["-fm.due"]);
    expect(sortTokens({ field: "relevance", direction: "desc" })).toEqual(["relevance", "-updated_at"]);
    expect(sortTokens({ field: "relevance", direction: "desc" }, false)).toEqual(["-updated_at"]);
  });

  it("asks for snippets only with text, and content only when asked", () => {
    const { search } = rowsFor([]);
    const sort = { field: "updated_at", direction: "desc" } as const;
    expect(searchQuery(search, "", filterOf(EMPTY_SPEC), sort).plan().stages).not.toContain("snippets");
    expect(searchQuery(search, "milk", filterOf(EMPTY_SPEC), sort).plan().stages).toEqual(
      expect.arrayContaining([{ text: "milk" }, "snippets"]),
    );
    expect(searchQuery(search, "", filterOf(EMPTY_SPEC), sort, { withContent: true }).plan().stages).toContain("with_content");
  });
});

describe("resolveSearch", () => {
  it("is every document, last updated first, hiding machine documents, for the empty search", async () => {
    const { search, runs } = rowsFor(["b", "c", "a"]);
    const rows = await resolveSearch(search, EMPTY_SPEC);
    expect(rows.map((row) => row.id)).toEqual(["b", "c", "a"]);
    expect(runs[0]?.stages).toEqual([{ where: EXCLUDE_MACHINE_DOCUMENTS }, { sort: ["-updated_at"] }, { limit: 50 }]);
  });

  it("hands text to the engine and keeps its ranking", async () => {
    const { search, runs } = rowsFor(["c", "a"]);
    const rows = await resolveSearch(search, { ...EMPTY_SPEC, query: " x " });
    expect(rows.map((row) => row.id)).toEqual(["c", "a"]);
    expect(runs[0]?.stages).toEqual(expect.arrayContaining([{ text: "x" }, { sort: ["relevance", "-updated_at"] }]));
  });

  it("reads best match ascending from the bottom", async () => {
    const { search } = rowsFor(["c", "a"]);
    const rows = await resolveSearch(search, { ...EMPTY_SPEC, query: "x", sort: { field: "relevance", direction: "asc" } });
    expect(rows.map((row) => row.id)).toEqual(["a", "c"]);
  });

  it("sends `is inside note` as the engine's own child_of, one condition per clause", async () => {
    const { search, runs } = rowsFor([]);
    await resolveSearch(search, {
      ...EMPTY_SPEC,
      filter: {
        combine: "or",
        includeMachine: true,
        clauses: [
          { id: "1", field: "id", op: "child_of", value: "root", kind: "doc", deep: true },
          { id: "2", field: "fm.status", op: "eq", value: "open", kind: "str" },
        ],
      },
    });
    expect(runs[0]?.stages?.[0]).toEqual({
      where: {
        or: [
          { child_of: { field: "id", of: "root", deep: true } },
          { cmp: { field: "fm.status", op: "eq", value: { str: "open" } } },
        ],
      },
    });
  });
});
