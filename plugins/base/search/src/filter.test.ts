import { describe, expect, it } from "vitest";

import {
  VALUELESS_OPS,
  appliedCount,
  buildClause,
  buildEffectiveFilter,
  buildFilter,
  clauseProblem,
  hasFilter,
  invalidClauses,
  replaceStep,
  stepConditions,
  type ClauseOp,
  type FilterDraft,
  type FilterClause,
  type ValueKind,
} from "./filter.js";
import { EXCLUDE_MACHINE_DOCUMENTS } from "../../_shared/machine-docs.js";

const clause = (over: Partial<FilterClause> = {}): FilterClause => ({
  id: "c1",
  field: "fm.status",
  op: "eq",
  value: "open",
  kind: "str",
  ...over,
});

describe("buildFilter", () => {
  it("returns undefined for an empty draft rather than an all node", () => {
    expect(buildFilter({ combine: "and", clauses: [] })).toBeUndefined();
  });

  it("returns a single node unwrapped", () => {
    expect(buildFilter({ combine: "and", clauses: [clause()] })).toEqual({
      cmp: { field: "fm.status", op: "eq", value: { str: "open" } },
    });
  });

  it("combines with and or or", () => {
    const draft = {
      combine: "or" as const,
      clauses: [clause(), clause({ id: "c2", field: "fm.tags", op: "contains" as const, value: "work" })],
    };
    expect(buildFilter(draft)).toEqual({
      or: [
        { cmp: { field: "fm.status", op: "eq", value: { str: "open" } } },
        { contains: { field: "fm.tags", value: { str: "work" } } },
      ],
    });
  });

  it("drops invalid clauses and reports which ones", () => {
    const draft = {
      combine: "and" as const,
      clauses: [clause(), clause({ id: "bad", value: "" })],
    };
    expect(buildFilter(draft)).toEqual({
      cmp: { field: "fm.status", op: "eq", value: { str: "open" } },
    });
    expect(invalidClauses(draft)).toEqual(["bad"]);
  });

  it("matches the documented example from the core README", () => {
    const draft = {
      combine: "and" as const,
      clauses: [
        clause({ id: "a", field: "fm.status", op: "eq" as const, value: "open", kind: "str" as const }),
        clause({ id: "b", field: "fm.tags", op: "contains" as const, value: "work", kind: "str" as const }),
        clause({
          id: "c",
          field: "updated_at",
          op: "gte" as const,
          value: "2026-01-01",
          kind: "date" as const,
        }),
        clause({ id: "d", field: "fm.due", op: "missing" as const, value: "", negate: true }),
      ],
    };
    expect(buildFilter(draft)).toEqual({
      and: [
        { cmp: { field: "fm.status", op: "eq", value: { str: "open" } } },
        { contains: { field: "fm.tags", value: { str: "work" } } },
        { cmp: { field: "updated_at", op: "gte", value: { date: "2026-01-01" } } },
        { not: { missing: { field: "fm.due" } } },
      ],
    });
  });
});

describe("buildEffectiveFilter", () => {
  it("hides machine-owned documents when nothing else is filtered", () => {
    expect(buildEffectiveFilter({ combine: "and", clauses: [] })).toEqual(
      EXCLUDE_MACHINE_DOCUMENTS,
    );
    expect(buildFilter({ combine: "and", clauses: [] })).toBeUndefined();
  });

  it("ands the exclusion onto whatever the user built", () => {
    const draft = { combine: "and", clauses: [clause()] } as const;
    expect(buildEffectiveFilter(draft)).toEqual({
      and: [buildFilter(draft), EXCLUDE_MACHINE_DOCUMENTS],
    });
  });

  it("is exactly the user's filter once the toggle is on", () => {
    expect(buildEffectiveFilter({ combine: "and", clauses: [], includeMachine: true })).toBeUndefined();
    const draft = { combine: "and", clauses: [clause()], includeMachine: true } as const;
    expect(buildEffectiveFilter(draft)).toEqual(buildFilter(draft));
  });
});

describe("an unusable clause contributes nothing to the query (MOBILE-AUDIT Q5)", () => {
  const fresh = clause({ id: "fresh", value: "" });

  it("leaves the effective filter byte-identical to the draft without it", () => {
    const without = { combine: "and", clauses: [] } as const;
    const with_ = { combine: "and", clauses: [fresh] } as const;
    expect(buildEffectiveFilter(with_)).toEqual(buildEffectiveFilter(without));
    expect(buildEffectiveFilter(with_)).toEqual(EXCLUDE_MACHINE_DOCUMENTS);
    expect(JSON.stringify(buildEffectiveFilter(with_))).toBe(
      JSON.stringify(EXCLUDE_MACHINE_DOCUMENTS),
    );
  });

  it("does not narrow a filter that has a usable clause beside it", () => {
    for (const combine of ["and", "or"] as const) {
      const good = { combine, clauses: [clause()] } as const;
      const mixed = { combine, clauses: [clause(), fresh] } as const;
      expect(buildFilter(mixed)).toEqual(buildFilter(good));
      expect(buildEffectiveFilter(mixed)).toEqual(buildEffectiveFilter(good));
    }
  });

  it("keeps the empty state truthful: no usable clause means the user filtered nothing", () => {
    expect(buildFilter({ combine: "and", clauses: [fresh] })).toBeUndefined();
  });

  it("is reported to the row, with a reason rather than a guess", () => {
    expect(invalidClauses({ combine: "and", clauses: [fresh] })).toEqual(["fresh"]);
    expect(clauseProblem(fresh)).toBe("Type a value to compare against.");
    expect(clauseProblem(clause({ op: "text_contains", kind: "date", value: "2026-09-23" }))).toBe(
      "Text matching needs the text value type.",
    );
    expect(clauseProblem(clause({ op: "lt", kind: "bool", value: "true" }))).toBe(
      "Before and after do not apply to true/false, null or a document.",
    );
  });
});

describe("clauseProblem is exactly the builder's own verdict", () => {
  const ops: readonly ClauseOp[] = [
    "eq", "ne", "lt", "lte", "gt", "gte",
    "contains", "any", "every",
    "text_contains", "text_starts_with", "text_ends_with",
    "missing", "exists", "is_null",
  ];
  const kinds: readonly ValueKind[] = ["str", "int", "float", "bool", "date", "null"];
  const values = ["", "   ", "open", "3", "1.5", "true", "2026-09-23", "2026-02-30", "2026"];
  const fields = ["fm.status", "title", "", " ", "fm", "not a path", "plugins.x.y"];

  it("agrees on every combination the controls can produce", () => {
    let disagreements = 0;
    let dropped = 0;
    for (const field of fields) {
      for (const op of ops) {
        for (const kind of kinds) {
          for (const value of values) {
            for (const negate of [false, true]) {
              const row = clause({ field, op, kind, value, negate });
              const built = buildClause(row) !== undefined;
              const problem = clauseProblem(row) === undefined;
              if (built !== problem) disagreements += 1;
              if (!built) dropped += 1;
            }
          }
        }
      }
    }
    expect(disagreements).toBe(0);
    expect(dropped).toBeGreaterThan(0);
  });

  it("says nothing about a row the valueless operators make complete on their own", () => {
    for (const op of VALUELESS_OPS) {
      expect(clauseProblem(clause({ op, value: "" }))).toBeUndefined();
    }
  });
});

describe("appliedCount", () => {
  it("counts what the query carries, not what the boxes hold", () => {
    expect(appliedCount({ combine: "and", clauses: [] })).toBe(0);
    expect(appliedCount({ combine: "and", clauses: [], includeMachine: true })).toBe(1);
    expect(appliedCount({ combine: "and", clauses: [clause(), clause({ id: "b", value: "" })] })).toBe(1);
    expect(appliedCount({ combine: "and", clauses: [clause()], includeMachine: true })).toBe(2);
  });
});

describe("editing one step of the chain", () => {
  const status: FilterClause = { id: "s", field: "fm.status", op: "eq", kind: "str", value: "open" };
  const client: FilterClause = { id: "x", field: "fm.client", op: "eq", kind: "str", value: "Acme" };
  const base: FilterDraft = { combine: "and", clauses: [status] };

  it("keeps a single condition as a plain where", () => {
    const next = replaceStep(base, "s", { combine: "and", clauses: [{ ...status, value: "done" }] });
    expect(next.clauses).toEqual([{ ...status, value: "done" }]);
    expect(next.groups).toBeUndefined();
  });

  it("turns a where into a group once it holds two conditions, and back", () => {
    const grouped = replaceStep(base, "s", { combine: "or", clauses: [status, client] });
    expect(grouped.clauses).toEqual([]);
    expect(grouped.groups).toEqual([{ id: "s", combine: "or", clauses: [status, client] }]);
    expect(stepConditions(grouped, "s")?.clauses).toHaveLength(2);
    const single = replaceStep(grouped, "s", { combine: "or", clauses: [client] });
    expect(single.clauses).toEqual([{ ...client, id: "s" }]);
    expect(single.groups).toBeUndefined();
  });

  it("keeps a negated group a group even with one condition", () => {
    const grouped = replaceStep(base, "s", { combine: "or", clauses: [status, client] });
    const negated = replaceStep(grouped, "s", { combine: "or", clauses: [client], negate: true });
    expect(negated.groups?.[0]).toEqual({ id: "s", combine: "or", clauses: [client], negate: true });
  });

  it("removes the step when its last condition goes", () => {
    expect(replaceStep(base, "s", { combine: "and", clauses: [] }).clauses).toEqual([]);
  });

  it("counts a usable group as a filter", () => {
    expect(hasFilter({ combine: "and", clauses: [], groups: [{ id: "g", combine: "or", clauses: [status] }] })).toBe(true);
    expect(hasFilter({ combine: "and", clauses: [], groups: [{ id: "g", combine: "or", clauses: [{ ...status, value: "" }] }] })).toBe(false);
  });
});
