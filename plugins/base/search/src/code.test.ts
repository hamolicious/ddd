import { describe, expect, it } from "vitest";

import type { FilterClause } from "../../_shared/conditions.js";

import { codeTokens, specCode } from "./code.js";
import { EMPTY_SPEC } from "./spec.js";

const clause = (overrides: Partial<FilterClause>): FilterClause => ({
  id: "c",
  field: "fm.status",
  op: "eq",
  kind: "str",
  value: "open",
  ...overrides,
});

const updated = { field: "updated_at", direction: "desc" } as const;
const relevance = { field: "relevance", direction: "desc" } as const;

describe("a search as kernel.search code", () => {
  it("is every note, newest first, without machine notes, for the empty search", () => {
    expect(specCode(EMPTY_SPEC, updated)).toBe(
      [
        "kernel.search",
        "  .from()",
        '  .where((w) => w.not(w("fm.machine", "eq", true)))',
        '  .sort("-updated_at")',
      ].join("\n"),
    );
  });

  it("chains text, one where per condition, any-of groups, inside, sort and snippets", () => {
    const code = specCode(
      {
        query: "invoice -draft",
        filter: {
          combine: "and",
          includeMachine: true,
          clauses: [clause({}), clause({ id: "i", field: "", op: "child_of", value: "01CLIENTS", deep: true })],
          groups: [
            {
              id: "g",
              combine: "or",
              clauses: [
                clause({ field: "fm.client", op: "contains_any", value: "Acme, Globex" }),
                clause({ field: "fm.due", op: "lt", kind: "date", value: "2026-11-01", negate: true }),
              ],
            },
          ],
        },
      },
      relevance,
    );
    expect(code).toBe(
      [
        "kernel.search",
        "  .from()",
        '  .text("invoice -draft")',
        '  .where("fm.status", "eq", "open")',
        '  .where("id", "child_of", "01CLIENTS", { deep: true })',
        '  .where((w) => w.or(w("fm.client", "contains_any", ["Acme", "Globex"]), w.not(w("fm.due", "lt", { date: "2026-11-01" }))))',
        '  .sort("relevance", "-updated_at")',
        "  .snippets()",
      ].join("\n"),
    );
  });

  it("puts everything in one or when the search matches any", () => {
    const code = specCode(
      { ...EMPTY_SPEC, filter: { combine: "or", includeMachine: true, clauses: [clause({}), clause({ field: "fm.done", kind: "bool", value: "true", negate: true })] } },
      updated,
    );
    expect(code).toContain('.where((w) => w.or(w("fm.status", "eq", "open"), w.not(w("fm.done", "eq", true))))');
  });

  it("leaves out conditions that are not finished", () => {
    const code = specCode({ ...EMPTY_SPEC, filter: { combine: "and", includeMachine: true, clauses: [clause({ value: "" })] } }, updated);
    expect(code).not.toContain("fm.status");
  });
});

describe("a typo-tolerant search as code", () => {
  it("ends the chain with fuzzy instead of sort and snippets", () => {
    const code = specCode({ ...EMPTY_SPEC, fuzzy: "teh qick", filter: { combine: "and", includeMachine: true, clauses: [clause({})] } }, relevance);
    expect(code).toBe(['kernel.search', '  .from()', '  .where("fm.status", "eq", "open")', '  .fuzzy("teh qick")'].join("\n"));
  });

  it("keeps text and fuzzy as their own steps", () => {
    const code = specCode({ ...EMPTY_SPEC, query: "invoice", fuzzy: "acme", filter: { combine: "and", includeMachine: true, clauses: [] } }, relevance);
    expect(code).toBe(['kernel.search', '  .from()', '  .text("invoice")', '  .fuzzy("acme")'].join("\n"));
  });
});

describe("highlighting the code", () => {
  it("marks methods, strings, numbers, constants and punctuation", () => {
    const tokens = codeTokens('kernel.search\n  .where("fm.n", "gt", 2, { deep: true })');
    const kinds = (kind: string) => tokens.filter((token) => token.kind === kind).map((token) => token.text);
    expect(kinds("function")).toEqual(["where"]);
    expect(kinds("property")).toEqual(["search", "deep"]);
    expect(kinds("string")).toEqual(['"fm.n"', '"gt"']);
    expect(kinds("number")).toEqual(["2"]);
    expect(kinds("constant")).toEqual(["true"]);
    expect(tokens.map((token) => token.text).join("")).toBe('kernel.search\n  .where("fm.n", "gt", 2, { deep: true })');
  });
});
