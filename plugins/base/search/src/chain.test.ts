import { describe, expect, it } from "vitest";

import type { FilterClause } from "../../_shared/conditions.js";

import { ANY_STEP, chainSteps, sortOptions, sortText } from "./chain.js";

const titles = (id: string): string => (id === "01C" ? "Clients" : "Unknown note");
const status: FilterClause = { id: "s", field: "fm.status", op: "eq", kind: "str", value: "open" };
const inside: FilterClause = { id: "i", field: "", op: "child_of", kind: "str", value: "01C", deep: true };
const client: FilterClause = { id: "x", field: "fm.client", op: "eq", kind: "str", value: "Acme" };

describe("the steps of the chain", () => {
  it("is one where per condition, an inside for a folder, and one per group", () => {
    const steps = chainSteps(
      { combine: "and", clauses: [status, inside], groups: [{ id: "g", combine: "or", clauses: [client, { ...client, id: "y", value: "Globex" }] }] },
      titles,
    );
    expect(steps).toEqual([
      { id: "s", verb: "where", text: "fm.status is open", ready: true },
      { id: "i", verb: "inside", text: "Clients and below", ready: true },
      { id: "g", verb: "where", text: "any of: fm.client is Acme · fm.client is Globex", ready: true },
    ]);
  });

  it("marks an unfinished step", () => {
    expect(chainSteps({ combine: "and", clauses: [{ ...status, value: "" }] }, titles)[0]?.ready).toBe(false);
    expect(chainSteps({ combine: "and", clauses: [{ ...inside, value: "" }] }, titles)[0]?.text).toBe("… and below");
  });

  it("folds a match-any search into one step", () => {
    const steps = chainSteps({ combine: "or", clauses: [status, client] }, titles);
    expect(steps).toEqual([{ id: ANY_STEP, verb: "where", text: "any of: fm.status is open · fm.client is Acme", ready: true }]);
  });
});

describe("the sort step", () => {
  it("offers best match only while there is text", () => {
    const sort = { field: "updated_at", direction: "desc" } as const;
    expect(sortOptions(false, sort, []).map((o) => o.field)).not.toContain("relevance");
    expect(sortOptions(true, sort, []).map((o) => o.field)[0]).toBe("relevance");
  });

  it("reads in words", () => {
    const options = sortOptions(true, { field: "updated_at", direction: "desc" }, []);
    expect(sortText({ field: "updated_at", direction: "desc" }, options)).toBe("Last updated, newest first");
    expect(sortText({ field: "title", direction: "asc" }, options)).toBe("Title, A to Z");
    expect(sortText({ field: "relevance", direction: "desc" }, options)).toBe("Best match, best match first");
  });

  it("keeps an unknown sort field as an option", () => {
    expect(sortOptions(false, { field: "fm.due", direction: "asc" }, []).at(-1)?.label).toBe("due");
  });
});
