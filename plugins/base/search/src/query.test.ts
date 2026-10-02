import { describe, expect, it, vi } from "vitest";

import type { DocumentsApi, PlanResult } from "@kernel";

import { QueryError, bindDocuments, query } from "./query.js";

describe("query()", () => {
  it("writes the plan the Rust builder writes", () => {
    const plan = query()
      .text(" milk ")
      .filter("title", "text_contains", "a")
      .anyOf((q) => q.filter("fm.status", "eq", "open").missing("fm.status"))
      .childOf("parent", true)
      .sort("fm.key")
      .sortDesc("updated_at")
      .limit(20)
      .plan();
    expect(plan).toEqual({
      text: "milk",
      filter: {
        and: [
          { text: { field: "title", mode: "contains", value: "a" } },
          {
            or: [
              { cmp: { field: "fm.status", op: "eq", value: { str: "open" } } },
              { missing: { field: "fm.status" } },
            ],
          },
          { child_of: { of: "parent", deep: true } },
        ],
      },
      sort: ["fm.key", "-updated_at"],
      limit: 20,
    });
  });

  it("types values as the DSL does", () => {
    const filters = query()
      .filter("fm.n", "gt", 2)
      .filter("fm.ratio", "lt", 0.5)
      .filter("fm.done", "eq", true)
      .filter("fm.due", "gte", { date: "2026-10-01" })
      .filter("fm.project", "eq", { doc: "01J" })
      .filter("fm.note", "eq", null)
      .plan().filter as { and: unknown[] };
    expect(filters.and.map((node) => (node as { cmp: { value: unknown } }).cmp.value)).toEqual([
      { int: 2 },
      { float: 0.5 },
      { bool: true },
      { date: "2026-10-01" },
      { str: "doc://01J" },
      "null",
    ]);
  });

  it("writes contains_any as an or of contains, and none_of as not-or", () => {
    expect(query().filterValues("fm.tags", "contains_any", ["a", "b"]).plan().filter).toEqual({
      or: [
        { contains: { field: "fm.tags", value: { str: "a" } } },
        { contains: { field: "fm.tags", value: { str: "b" } } },
      ],
    });
    expect(query().noneOf((q) => q.parentOf("x")).plan().filter).toEqual({
      not: { or: [{ parent_of: { of: "x" } }] },
    });
  });

  it("keeps a mistake for plan() to throw", () => {
    expect(() => query().filter("nope", "eq", "x").plan()).toThrow(QueryError);
    expect(() => query().filter("fm.n", "lt", true).plan()).toThrow(/cannot order/);
    expect(() => query().filter("title", "text_contains", 3).plan()).toThrow(/takes text/);
    expect(() => query().sort("fm.").plan()).toThrow(QueryError);
    expect(() => query().childOf(" ").plan()).toThrow(/note id/);
    expect(() => query().anyOf((q) => q.filter("bad", "eq", 1)).plan()).toThrow(QueryError);
  });

  it("is immutable: a base query can be shared", () => {
    const base = query().filter("fm.status", "eq", "open");
    const sorted = base.sort("title");
    expect(base.plan().sort).toBeUndefined();
    expect(sorted.plan().sort).toEqual(["title"]);
  });

  it("runs through the kernel once active", async () => {
    expect(() => query().run()).toThrow(/not active/);
    const answer: PlanResult = { rows: [], total: 0, hits: {} };
    const queryPlan = vi.fn(async () => answer);
    bindDocuments({ queryPlan } as unknown as DocumentsApi);
    await expect(query().text("milk").run()).resolves.toBe(answer);
    expect(queryPlan).toHaveBeenCalledWith({ text: "milk" });
    bindDocuments(undefined);
  });
});
