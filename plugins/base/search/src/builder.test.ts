import { describe, expect, it, vi } from "vitest";

import type { DocumentsApi, PlanResult } from "@kernel";

import { and, childOf, doc, field, fromSpec, not, or, parentOf, raw, search } from "./builder.js";
import { EXCLUDE_MACHINE_DOCUMENTS } from "../../_shared/machine-docs.js";
import { encodeSpec, parseSpec } from "./spec.js";
import { QueryError, bindDocuments, query, useQuery } from "./query.js";

const row = (id: string) => ({ id }) as unknown as PlanResult["rows"][number];

describe("search()", () => {
  it("writes the plan query() writes, machine documents left out", () => {
    const v2 = search()
      .text(" milk ")
      .where(field("title").textContains("a"))
      .where(or(field("fm.status").eq("open"), field("fm.status").missing()))
      .where(childOf("parent", { deep: true }))
      .orderBy("fm.key")
      .orderBy("updated_at", "desc")
      .limit(20)
      .plan();
    const v1 = query()
      .text(" milk ")
      .filter("title", "text_contains", "a")
      .anyOf((q) => q.filter("fm.status", "eq", "open").missing("fm.status"))
      .childOf("parent", true)
      .sort("fm.key")
      .sortDesc("updated_at")
      .limit(20)
      .plan();
    expect(v2).toEqual({ ...v1, filter: { and: [v1.filter, EXCLUDE_MACHINE_DOCUMENTS] } });
    expect(search().includeMachine().plan()).toEqual({});
    expect(search().plan()).toEqual({ filter: EXCLUDE_MACHINE_DOCUMENTS });
  });

  it("takes dates, notes, ranges, sets and raw nodes as values", () => {
    const when = new Date("2026-10-01T09:30:00.000Z");
    const plan = search()
      .includeMachine()
      .where(
        field("fm.due").lte(when),
        field("fm.project").eq(doc("01J")),
        field("fm.n").between(1, 2.5),
        field("fm.status").oneOf("open", "doing"),
        field("fm.tags").containsAny("a", "b"),
        not(parentOf("x")),
        raw({ exists: { field: "fm.z" } }),
      )
      .plan();
    expect(plan.filter).toEqual({
      and: [
        { cmp: { field: "fm.due", op: "lte", value: { date: "2026-10-01T09:30:00.000Z" } } },
        { cmp: { field: "fm.project", op: "eq", value: { str: "doc://01J" } } },
        {
          and: [
            { cmp: { field: "fm.n", op: "gte", value: { int: 1 } } },
            { cmp: { field: "fm.n", op: "lte", value: { float: 2.5 } } },
          ],
        },
        { in: { field: "fm.status", values: [{ str: "open" }, { str: "doing" }] } },
        {
          or: [
            { contains: { field: "fm.tags", value: { str: "a" } } },
            { contains: { field: "fm.tags", value: { str: "b" } } },
          ],
        },
        { not: { parent_of: { of: "x" } } },
        { exists: { field: "fm.z" } },
      ],
    });
  });

  it("is a value: a condition is shared, and a base search is not changed by extending it", () => {
    const open = field("fm.status").eq("open");
    expect(JSON.parse(JSON.stringify(open))).toEqual(open);
    const base = search().where(open);
    const sorted = base.orderBy("title");
    expect(base.plan().sort).toBeUndefined();
    expect(sorted.plan().sort).toEqual(["title"]);
    expect(search().where(and(open, open)).plan().filter).toEqual(search().where(open, open).plan().filter);
  });

  it("keeps a mistake for plan() to throw", () => {
    expect(() => search().where(field("nope").eq("x")).plan()).toThrow(QueryError);
    expect(() => search().where(field("fm.n").lt(true)).plan()).toThrow(/cannot order/);
    expect(() => search().where(field("fm.n").oneOf(1, "a")).plan()).toThrow(/one kind/);
    expect(() => search().where(field("fm.n").oneOf()).plan()).toThrow(/at least one/);
    expect(() => search().where(or()).plan()).toThrow(/empty/);
    expect(() => search().where(field("fm.due").eq(new Date("junk"))).plan()).toThrow(/invalid Date/);
    expect(() => search().orderBy("fm.").plan()).toThrow(/sortable/);
    expect(() => search().where(childOf(" ")).plan()).toThrow(/note id/);
    // Nothing is thrown before the plan is asked for: a hook may hold a wrong one.
    expect(() => search().orderBy("fm.").where(field("x").eq(1))).not.toThrow();
  });

  it("is the search the shell shows: toSpec() round-trips through the query string", () => {
    const built = search()
      .text("milk")
      .where(
        field("fm.status").eq("open"),
        not(field("fm.n").gt(3)),
        field("fm.due").lte({ date: "2026-10-01" }),
        field("fm.tags").containsAny("a", "b"),
        field("fm.project").eq(doc("01J")),
        field("fm.done").ne(true),
        field("fm.note").isNull(),
        field("fm.x").missing(),
        childOf("p", { deep: true }),
        parentOf("c"),
      )
      .orderBy("fm.due", "desc");
    const spec = built.toSpec();
    expect(spec.query).toBe("milk");
    expect(spec.sort).toEqual({ field: "fm.due", direction: "desc" });
    expect(spec.filter.combine).toBe("and");
    expect(spec.filter.clauses.map(({ id: _id, ...rest }) => rest)).toEqual([
      { field: "fm.status", op: "eq", kind: "str", value: "open" },
      { field: "fm.n", op: "gt", kind: "int", value: "3", negate: true },
      { field: "fm.due", op: "lte", kind: "date", value: "2026-10-01" },
      { field: "fm.tags", op: "contains_any", kind: "str", value: "a, b" },
      { field: "fm.project", op: "eq", kind: "doc", value: "01J" },
      { field: "fm.done", op: "ne", kind: "bool", value: "true" },
      { field: "fm.note", op: "is_null", kind: "str", value: "" },
      { field: "fm.x", op: "missing", kind: "str", value: "" },
      { field: "", op: "child_of", kind: "str", value: "p", deep: true },
      { field: "", op: "parent_of", kind: "str", value: "c" },
    ]);
    // The same search, as a URL, read back, is the same plan.
    const again = search(parseSpec(encodeSpec(spec)));
    expect(again.plan()).toEqual(built.plan());
    expect(encodeSpec(again.toSpec())).toBe(encodeSpec(spec));
  });

  it("shows one or-group as 'match any', relevance as best match, and machine documents when asked", () => {
    const any = search().where(or(field("fm.a").eq(1), or(field("fm.b").eq(2)))).toSpec();
    expect(any.filter.combine).toBe("or");
    expect(any.filter.clauses).toHaveLength(2);

    const best = search().text("x").byRelevance().orderBy("updated_at", "desc").includeMachine().toSpec();
    expect(best.sort).toEqual({ field: "relevance", direction: "desc" });
    expect(best.filter.includeMachine).toBe(true);
    expect(search(best).plan()).toEqual({ text: "x", sort: ["relevance", "-updated_at"] });

    // Paging and snippets are the view's; they are left out, not refused.
    expect(search().limit(5).offset(10).snippets().toSpec()).toEqual({ query: "", filter: { combine: "and", clauses: [] } });
  });

  it("says which queries no search can show", () => {
    expect(() => search().where(field("fm.s").oneOf("a")).toSpec()).toThrow(/oneOf/);
    expect(() => search().where(or(field("fm.a").eq(1), and(field("fm.b").eq(2), field("fm.c").eq(3)))).toSpec()).toThrow(/group inside/);
    expect(() => search().where(not(or(field("fm.a").eq(1), field("fm.b").eq(2)))).toSpec()).toThrow(/negated group/);
    expect(() => search().where(raw({ exists: { field: "fm.z" } })).toSpec()).toThrow(/raw/);
    expect(() => search().orderBy("a").orderBy("b").toSpec()).toThrow(/one field/);
    expect(() => search().trash("trashed").toSpec()).toThrow(/Trash/);
    expect(() => search().where(field("fm.tags").containsAny("a,b")).toSpec()).toThrow(/comma/);
  });

  it("reads a spec as the shell does: a half-typed row is no condition", () => {
    const spec = parseSpec("q=a&where=" + encodeURIComponent(JSON.stringify([["fm.n", "eq", "int", "2"], ["fm.due", "eq", "date", ""], ["bad field", "eq", "str", "x"], ["", "child_of", "str", "  "]])));
    expect(fromSpec(spec).includeMachine().plan()).toEqual({
      text: "a",
      filter: { cmp: { field: "fm.n", op: "eq", value: { int: 2 } } },
    });
  });

  it("answers in the shape asked for", async () => {
    const pages: PlanResult[] = [
      { rows: [row("a"), row("b")], total: 3, hits: {}, nextCursor: "2.x" },
      { rows: [row("c")], total: 3, hits: {} },
    ];
    const queryPlan = vi.fn(async () => pages.shift() as PlanResult);
    bindDocuments({ queryPlan } as unknown as DocumentsApi);
    const base = search().includeMachine().offset(0).limit(2);
    await expect(base.all()).resolves.toEqual([row("a"), row("b"), row("c")]);
    expect(queryPlan).toHaveBeenLastCalledWith({ limit: 2, cursor: "2.x" });

    pages.push({ rows: [row("z")], total: 9, hits: {} });
    await expect(base.first()).resolves.toEqual(row("z"));
    expect(queryPlan).toHaveBeenLastCalledWith({ limit: 1, offset: 0 });
    pages.push({ rows: [row("z")], total: 9, hits: {} });
    await expect(base.count()).resolves.toBe(9);
    pages.push({ rows: [row("z"), row("y")], total: 9, hits: {} });
    await expect(base.ids()).resolves.toEqual(["z", "y"]);
    bindDocuments(undefined);
    expect(() => search().run()).toThrow(/not active/);
    expect(() => search().save()).toThrow(/not active/);
  });

  it("is a plan for useQuery", () => {
    expect(typeof useQuery).toBe("function");
    expect(search().where(field("fm.a").eq(1)).includeMachine().plan()).toEqual(query().filter("fm.a", "eq", 1).plan());
  });
});
