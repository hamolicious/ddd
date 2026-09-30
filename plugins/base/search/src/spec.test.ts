import { describe, expect, it } from "vitest";

import type { SearchSpec } from "./api.js";

import type { FilterDraft } from "./filter.js";
import { EMPTY_SPEC, NO_FILTER, effectiveSort, encodeSpec, parseSpec, queryOf, sameSpec } from "./spec.js";

const spec = (overrides: Partial<SearchSpec> = {}): SearchSpec => ({ ...EMPTY_SPEC, ...overrides });

describe("a search's query string", () => {
  it("is empty for the default search", () => {
    expect(encodeSpec(EMPTY_SPEC)).toBe("");
    expect(parseSpec("")).toEqual(EMPTY_SPEC);
  });

  it("round-trips the text, the filter with its flags, the sort", () => {
    const filter: FilterDraft = {
      combine: "or",
      includeMachine: true,
      clauses: [
        { id: "a", field: "fm.status", op: "eq", kind: "str", value: "open & shut, \"really\"" },
        { id: "b", field: "", op: "child_of", kind: "str", value: "01J", deep: true, negate: true },
        { id: "c", field: "fm.due", op: "lt", kind: "date", value: "2026-0" },
      ],
    };
    const original = spec({
      query: "milk run",
      filter,
      sort: { field: "fm.due", direction: "asc" },
    });
    const back = parseSpec(encodeSpec(original));
    expect(sameSpec(back, original)).toBe(true);
    expect(back.query).toBe("milk run");
    expect(back.sort).toEqual({ field: "fm.due", direction: "asc" });
    expect(back.filter.clauses.map(({ id: _, ...rest }) => rest)).toEqual(filter.clauses.map(({ id: _, ...rest }) => rest));
    expect(back.filter.combine).toBe("or");
    expect(back.filter.includeMachine).toBe(true);
  });

  it("ignores the view params older searches held", () => {
    const old = parseSpec("q=milk&view=kanban&v.group=fm.status&cols=fm.status&rows=25");
    expect(old).toEqual({ ...EMPTY_SPEC, query: "milk" });
    expect(encodeSpec(old)).toBe("q=milk");
  });

  it("drops junk: a bad filter, a bad sort", () => {
    expect(parseSpec("q=milk").filter).toEqual(NO_FILTER);
    expect(parseSpec("where=%5Bnot-json").filter).toEqual(NO_FILTER);
    const partly = parseSpec(
      `where=${encodeURIComponent(JSON.stringify([["title", "nope", "str", "x"], ["title", "eq", "str", "x"], 3]))}`,
    );
    expect(partly.filter.clauses).toHaveLength(1);
    expect(parseSpec("sort=title:sideways").sort).toBeUndefined();
    expect(parseSpec("sort=:asc").sort).toBeUndefined();
  });

  it("takes the query string out of a hash route", () => {
    expect(queryOf("#/?q=milk")).toBe("q=milk");
    expect(queryOf("#/")).toBe("");
  });
});

describe("the sort in force", () => {
  it("is best match while searching, last updated otherwise, unless the search says", () => {
    expect(effectiveSort(spec({ query: "milk" }))).toEqual({ field: "relevance", direction: "desc" });
    expect(effectiveSort(spec())).toEqual({ field: "updated_at", direction: "desc" });
    expect(effectiveSort(spec({ sort: { field: "title", direction: "asc" } }))).toEqual({ field: "title", direction: "asc" });
  });

  it("falls back from best match when there is no text to rank by", () => {
    expect(effectiveSort(spec({ sort: { field: "relevance", direction: "desc" } }))).toEqual({
      field: "updated_at",
      direction: "desc",
    });
  });
});
