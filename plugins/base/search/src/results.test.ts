import { describe, expect, it } from "vitest";

import type { DocumentRow, DocumentsApi, QueryPlan } from "@kernel";

import { EXCLUDE_MACHINE_DOCUMENTS } from "../../_shared/machine-docs.js";

import { planFor, resolveSearch, sortTokens } from "./results.js";
import { EMPTY_SPEC } from "./spec.js";

function fakeDocuments(ids: readonly string[]): { documents: DocumentsApi; plans: QueryPlan[] } {
  const plans: QueryPlan[] = [];
  const documents = {
    queryPlan: (plan: QueryPlan) => {
      plans.push(plan);
      const rows = ids.map((id) => ({ id, title: id, fm: {} }) as unknown as DocumentRow);
      return Promise.resolve({ rows, total: rows.length, hits: {} });
    },
  } as unknown as DocumentsApi;
  return { documents, plans };
}

describe("a search as a plan", () => {
  it("sorts by the search's sort, and breaks best-match ties by last updated", () => {
    expect(sortTokens({ field: "title", direction: "asc" })).toEqual(["title"]);
    expect(sortTokens({ field: "fm.due", direction: "desc" })).toEqual(["-fm.due"]);
    expect(sortTokens({ field: "relevance", direction: "desc" })).toEqual(["relevance", "-updated_at"]);
  });

  it("asks for snippets only with text", () => {
    expect(planFor("", undefined, { field: "updated_at", direction: "desc" }, 50)).toEqual({ sort: ["-updated_at"], limit: 50 });
    expect(planFor("milk", undefined, { field: "relevance", direction: "desc" }, 10)).toMatchObject({ text: "milk", snippets: true });
  });
});

describe("resolveSearch", () => {
  it("is every document, last updated first, hiding machine documents, for the empty search", async () => {
    const { documents, plans } = fakeDocuments(["b", "c", "a"]);
    const rows = await resolveSearch(documents, EMPTY_SPEC);
    expect(rows.map((row) => row.id)).toEqual(["b", "c", "a"]);
    expect(plans[0]?.sort).toEqual(["-updated_at"]);
    expect(plans[0]?.text).toBeUndefined();
    expect(plans[0]?.filter).toEqual(EXCLUDE_MACHINE_DOCUMENTS);
  });

  it("hands text to the engine and keeps its ranking", async () => {
    const { documents, plans } = fakeDocuments(["c", "a"]);
    const rows = await resolveSearch(documents, { ...EMPTY_SPEC, query: " x " });
    expect(rows.map((row) => row.id)).toEqual(["c", "a"]);
    expect(plans[0]).toMatchObject({ text: "x", sort: ["relevance", "-updated_at"] });
  });

  it("reads best match ascending from the bottom", async () => {
    const { documents } = fakeDocuments(["c", "a"]);
    const rows = await resolveSearch(documents, { ...EMPTY_SPEC, query: "x", sort: { field: "relevance", direction: "asc" } });
    expect(rows.map((row) => row.id)).toEqual(["a", "c"]);
  });

  it("sends `is inside note` as the engine's own child_of", async () => {
    const { documents, plans } = fakeDocuments([]);
    await resolveSearch(documents, {
      ...EMPTY_SPEC,
      filter: {
        combine: "and",
        includeMachine: true,
        clauses: [{ id: "1", field: "id", op: "child_of", value: "root", kind: "doc", deep: true }],
      },
    });
    expect(plans[0]?.filter).toEqual({ child_of: { of: "root", deep: true } });
  });
});
