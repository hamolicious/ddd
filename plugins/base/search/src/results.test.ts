import { describe, expect, it } from "vitest";

import type { DocumentQuery, DocumentRow, DocumentsApi } from "@kernel";

import { resolveSearch } from "./results.js";
import { EMPTY_SPEC } from "./spec.js";
import type { SearchEngine } from "./useSearch.js";

const row = (id: string, updated: string): DocumentRow => ({ id, title: id, fm: {}, updated_at: updated }) as DocumentRow;
const ROWS = [row("a", "2026-01-01"), row("b", "2026-03-01"), row("c", "2026-02-01")];

/** Enough of `documents` for `resolveSearch`: `in` on ids, and one sort key. */
function fakeDocuments(): { documents: DocumentsApi; queries: DocumentQuery[] } {
  const queries: DocumentQuery[] = [];
  const documents = {
    query: (query: DocumentQuery) => {
      queries.push(query);
      const filter = JSON.stringify(query.filter ?? {});
      const ids = [...filter.matchAll(/"str":"(\w+)"/g)].map((match) => match[1]);
      let rows = filter.includes('"in"') ? ROWS.filter((candidate) => ids.includes(candidate.id)) : [...ROWS];
      const key = query.sort?.[0];
      if (key) {
        rows = rows.sort((x, y) => String(x[key.field as keyof DocumentRow]).localeCompare(String(y[key.field as keyof DocumentRow])));
        if (key.direction === "desc") rows.reverse();
      }
      return Promise.resolve({ rows: rows.slice(0, query.limit ?? rows.length), total: rows.length });
    },
  } as unknown as DocumentsApi;
  return { documents, queries };
}

const engine = (ranked: readonly string[]): SearchEngine => ({
  run: () =>
    Promise.resolve([
      { providerId: "local", label: "Local", order: 0, hits: ranked.map((id, index) => ({ id, score: 10 - index, terms: [] })) },
    ]),
});

describe("resolveSearch", () => {
  it("is every document, last updated first, for the empty search", async () => {
    const { documents } = fakeDocuments();
    const rows = await resolveSearch(documents, engine([]), EMPTY_SPEC);
    expect(rows.map((candidate) => candidate.id)).toEqual(["b", "c", "a"]);
  });

  it("keeps the providers' rank for text, within what the query allows", async () => {
    const { documents, queries } = fakeDocuments();
    const rows = await resolveSearch(documents, engine(["c", "a"]), { ...EMPTY_SPEC, query: "x" });
    expect(rows.map((candidate) => candidate.id)).toEqual(["c", "a"]);
    expect(JSON.stringify(queries[0]?.filter)).toContain('"in"');
  });

  it("sorts by the search's own sort, and finds nothing when the providers do", async () => {
    const { documents } = fakeDocuments();
    const sorted = await resolveSearch(documents, engine([]), { ...EMPTY_SPEC, sort: { field: "id", direction: "asc" } });
    expect(sorted.map((candidate) => candidate.id)).toEqual(["a", "b", "c"]);
    expect(await resolveSearch(documents, engine([]), { ...EMPTY_SPEC, query: "none" })).toEqual([]);
  });
});
