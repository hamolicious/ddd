import { describe, expect, expectTypeOf, it } from "vitest";

import type { FmValue } from "./types.js";
import {
  createSearchApi,
  type SearchDocumentRow,
  type SearchPlanJson,
  type SearchResult,
  type SearchSnippet,
} from "./search.js";

const plans: SearchPlanJson[] = [];
const search = createSearchApi({
  run: (plan) => {
    plans.push(plan);
    return Promise.resolve({ rows: [] });
  },
  watch: () => Promise.reject(new Error("unused")),
});

type RowOf<P> = P extends Promise<SearchResult<infer Row, infer _Opts>> ? Row : never;

describe("search builder types", () => {
  it("returns the document row without content by default", () => {
    const run = search.from().run;
    expectTypeOf<RowOf<ReturnType<typeof run>>>().toEqualTypeOf<SearchDocumentRow>();
    const withContent = search.from().withContent();
    expectTypeOf<RowOf<ReturnType<typeof withContent.run>>>().toMatchTypeOf<{ readonly content: string }>();
  });

  it("narrows rows to selected fields, with aliases", () => {
    const query = search.from().select("id", "title", { client: "fm.client" });
    expectTypeOf<RowOf<ReturnType<typeof query.run>>>().toEqualTypeOf<{
      readonly id: string;
      readonly title: string;
      readonly client: FmValue;
    }>();
  });

  it("reshapes rows for groups and aggregates", () => {
    const query = search.from("fm").groupBy("key").count("documents").collect("kind", "kinds");
    expectTypeOf<RowOf<ReturnType<typeof query.run>>>().toEqualTypeOf<{
      readonly key: string;
      readonly documents: number;
      readonly kinds: ("string" | "number" | "boolean" | "date" | "null")[];
    }>();
    const overall = search.from().count().sum("words", "total");
    expectTypeOf<RowOf<ReturnType<typeof overall.run>>>().toEqualTypeOf<{
      readonly count: number;
      readonly total: number | null;
    }>();
  });

  it("lets a filter after a group see only group fields and aggregates", () => {
    const grouped = search.from().groupBy("fm.client").count("open");
    grouped.where("open", "gt", 5);
    grouped.where("fm.client", "eq", "acme");
    // @ts-expect-error title is not a group field
    grouped.where("title", "eq", "x");
  });

  it("rejects unknown fields but keeps frontmatter open", () => {
    search.from().where("fm.anything.at.all", "eq", 1);
    search.from("tasks").where("doc.fm.status", "eq", "open").sort("-doc.updated_at", "line");
    // @ts-expect-error not a column
    search.from().where("titel", "eq", "x");
    // @ts-expect-error tasks have no title of their own
    search.from("tasks").select("title");
  });

  it("types non-document rows with their document", () => {
    const run = search.from("tasks").run;
    expectTypeOf<RowOf<ReturnType<typeof run>>>().toMatchTypeOf<{
      readonly line: number;
      readonly state: "open" | "done" | "other";
      readonly doc: SearchDocumentRow;
    }>();
  });

  it("adds total only after withTotal, and snippets after snippets()", () => {
    const plain = search.from();
    type Plain = Awaited<ReturnType<typeof plain.run>>;
    expectTypeOf<Plain["total"]>().toEqualTypeOf<undefined>();
    const counted = search.from().withTotal();
    expectTypeOf<Awaited<ReturnType<typeof counted.run>>["total"]>().toEqualTypeOf<number>();
    const snipped = search.from().text("x").snippets().select("id");
    expectTypeOf<RowOf<ReturnType<typeof snipped.run>>>().toEqualTypeOf<{ readonly id: string }>();
    const kept = search.from().text("x").snippets();
    expectTypeOf<RowOf<ReturnType<typeof kept.run>>>().toMatchTypeOf<{ readonly snippet: SearchSnippet | null }>();
  });
});

describe("search builder plans", () => {
  it("appends stages in call order and never mutates", async () => {
    const base = search.from();
    const open = base.where("fm.status", "eq", "open");
    expect(base.plan()).toEqual({ source: "documents", stages: [] });
    await open.text('invoice -draft "acme corp"').sort("-updated_at").select("id", { client: "fm.client" }).limit(20).run();
    expect(plans.at(-1)).toEqual({
      source: "documents",
      stages: [
        { where: { cmp: { field: "fm.status", op: "eq", value: { str: "open" } } } },
        { text: 'invoice -draft "acme corp"' },
        { sort: ["-updated_at"] },
        { select: [{ field: "id" }, { field: "fm.client", as: "client" }] },
        { limit: 20 },
      ],
    });
  });

  it("builds conditions, matches and subqueries", () => {
    const linksToX = search.from("links").where("target", "eq", "X").select("doc.id");
    const plan = search
      .from()
      .where((w) => w.or(w("fm.status", "eq", "open"), w.and(w("fm.n", "gte", 1.5), w.not(w("fm.machine", "eq", true)))))
      .where("id", "child_of", "F", { deep: true })
      .where("id", "in", linksToX)
      .where("fm.tags", "contains_any", ["a", null])
      .where("fm.scores", "every", ["gt", 2])
      .where("fm.gone", "missing")
      .match((m) => m.and(m.term("invoice"), m.not(m.term("draft")), m.in("title", m.prefix("q3"))))
      .plan();
    expect(plan.stages).toEqual([
      {
        where: {
          or: [
            { cmp: { field: "fm.status", op: "eq", value: { str: "open" } } },
            {
              and: [
                { cmp: { field: "fm.n", op: "gte", value: { float: 1.5 } } },
                { not: { cmp: { field: "fm.machine", op: "eq", value: { bool: true } } } },
              ],
            },
          ],
        },
      },
      { where: { child_of: { field: "id", of: "F", deep: true } } },
      { where: { in_plan: { field: "id", plan: linksToX.plan() } } },
      { where: { contains_any: { field: "fm.tags", values: [{ str: "a" }, "null"] } } },
      { where: { every: { field: "fm.scores", op: "gt", value: { int: 2 } } } },
      { where: { missing: { field: "fm.gone" } } },
      {
        match: {
          and: [{ term: "invoice" }, { not: { term: "draft" } }, { in: { field: "title", expr: { prefix: "q3" } } }],
        },
      },
    ]);
  });

  it("turns a stored plan back into a builder", () => {
    const stored = search.from("tasks").where("state", "eq", "open").plan();
    expect(search.fromPlan(stored).limit(3).plan()).toEqual({ ...stored, stages: [...(stored.stages ?? []), { limit: 3 }] });
  });
});
