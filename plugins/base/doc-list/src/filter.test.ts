/**
 * The filter builder against the DSL grammar in `backend/crates/core/README.md` §4.
 *
 * These tests are the cheap half of a contract the expensive half of which is the Rust
 * conformance corpus: the builder must only ever emit nodes that corpus covers. Every
 * case below names the grammar rule it is defending.
 */

import { describe, expect, it } from "vitest";

import {
  TRASHED_ONLY,
  VALUELESS_OPS,
  appliedCount,
  buildClause,
  buildEffectiveFilter,
  buildFilter,
  buildLiteral,
  buildSort,
  clauseProblem,
  invalidClauses,
  isFieldPathShaped,
  TRASH_SORT_IS_CLIENT_SIDE,
  type ClauseOp,
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

describe("buildLiteral", () => {
  it("emits the tagged forms the wire format defines", () => {
    expect(buildLiteral("str", "open")).toEqual({ str: "open" });
    expect(buildLiteral("int", "3")).toEqual({ int: 3 });
    expect(buildLiteral("float", "1.5")).toEqual({ float: 1.5 });
    expect(buildLiteral("bool", "TRUE")).toEqual({ bool: true });
    expect(buildLiteral("date", "2026-01-01")).toEqual({ date: "2026-01-01" });
    // `null` is the one bare string in the grammar.
    expect(buildLiteral("null", "")).toBe("null");
  });

  it("refuses a value that is not of the chosen family", () => {
    expect(buildLiteral("int", "1.5")).toBeUndefined();
    expect(buildLiteral("int", "")).toBeUndefined();
    expect(buildLiteral("bool", "yes")).toBeUndefined();
    expect(buildLiteral("str", "   ")).toBeUndefined();
  });

  it("refuses a date the core would refuse, so a half-typed one is no clause", () => {
    expect(buildLiteral("date", "2026-0")).toBeUndefined();
    expect(buildLiteral("date", "2026-02-30")).toBeUndefined();
    expect(buildLiteral("date", "2026-13-01")).toBeUndefined();
    expect(buildLiteral("date", "2026-02-29")).toBeUndefined(); // 2026 is not a leap year
    expect(buildLiteral("date", "2028-02-29")).toEqual({ date: "2028-02-29" });
    expect(buildLiteral("date", "2026-09-23T10:00:00Z")).toEqual({ date: "2026-09-23T10:00:00Z" });
  });
});

describe("isFieldPathShaped", () => {
  it("accepts the fixed roots as single segments and the dynamic roots as two or more", () => {
    expect(isFieldPathShaped("title")).toBe(true);
    expect(isFieldPathShaped("updated_at")).toBe(true);
    expect(isFieldPathShaped("fm.status")).toBe(true);
    expect(isFieldPathShaped("plugins.calendar.uid")).toBe(true);
  });

  it("rejects what the core's path parser rejects", () => {
    expect(isFieldPathShaped("fm")).toBe(false); // needs a key
    expect(isFieldPathShaped("title.sub")).toBe(false); // fixed roots take one segment
    expect(isFieldPathShaped("unknown")).toBe(false);
    expect(isFieldPathShaped("fm.a.b.c.d.e.f.g")).toBe(false); // 7 segments max
    expect(isFieldPathShaped("fm.$where")).toBe(false); // cannot inject operator syntax
    expect(isFieldPathShaped("")).toBe(false);
  });
});

describe("buildClause", () => {
  it("builds a scalar comparison", () => {
    expect(buildClause(clause())).toEqual({
      cmp: { field: "fm.status", op: "eq", value: { str: "open" } },
    });
  });

  it("wraps a negated clause in not", () => {
    expect(buildClause(clause({ negate: true }))).toEqual({
      not: { cmp: { field: "fm.status", op: "eq", value: { str: "open" } } },
    });
  });

  it("uses the explicit list operators — there is no implicit array matching", () => {
    expect(buildClause(clause({ field: "fm.tags", op: "contains", value: "work" }))).toEqual({
      contains: { field: "fm.tags", value: { str: "work" } },
    });
    expect(buildClause(clause({ field: "fm.tags", op: "any", value: "work" }))).toEqual({
      any: { field: "fm.tags", op: "eq", value: { str: "work" } },
    });
    expect(buildClause(clause({ field: "fm.tags", op: "every", value: "work" }))).toEqual({
      every: { field: "fm.tags", op: "eq", value: { str: "work" } },
    });
  });

  it("keeps missing, exists and is_null as three different questions", () => {
    expect(buildClause(clause({ op: "missing", value: "" }))).toEqual({
      missing: { field: "fm.status" },
    });
    expect(buildClause(clause({ op: "exists", value: "" }))).toEqual({
      exists: { field: "fm.status" },
    });
    expect(buildClause(clause({ op: "is_null", value: "" }))).toEqual({
      is_null: { field: "fm.status" },
    });
  });

  it("builds the three text modes", () => {
    expect(buildClause(clause({ field: "title", op: "text_contains", value: "milk" }))).toEqual({
      text: { field: "title", mode: "contains", value: "milk" },
    });
    expect(buildClause(clause({ field: "title", op: "text_starts_with", value: "a" }))).toEqual({
      text: { field: "title", mode: "starts_with", value: "a" },
    });
    expect(buildClause(clause({ field: "title", op: "text_ends_with", value: "z" }))).toEqual({
      text: { field: "title", mode: "ends_with", value: "z" },
    });
  });

  it("refuses combinations both engines refuse", () => {
    // `text` against a non-string column.
    expect(buildClause(clause({ op: "text_contains", kind: "int", value: "3" }))).toBeUndefined();
    // An ordering operator against a bool or null literal.
    expect(buildClause(clause({ op: "gt", kind: "bool", value: "true" }))).toBeUndefined();
    expect(buildClause(clause({ op: "lt", kind: "null", value: "" }))).toBeUndefined();
    // An unparseable field path.
    expect(buildClause(clause({ field: "nope" }))).toBeUndefined();
  });

  it("produces nothing for an incomplete row", () => {
    expect(buildClause(clause({ value: "" }))).toBeUndefined();
    expect(buildClause(clause({ kind: "date", value: "2026" }))).toBeUndefined();
  });
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

describe("the Trash partition", () => {
  it("selects tombstoned rows through the derived `deleted` field", () => {
    expect(TRASHED_ONLY).toEqual({ cmp: { field: "deleted", op: "eq", value: { bool: true } } });
  });
});

describe("buildSort", () => {
  it("produces one key; `id` is appended by both engines as the tiebreaker", () => {
    expect(buildSort("updated_at", "desc")).toEqual([{ field: "updated_at", direction: "desc" }]);
  });

  /**
   * The Trash view's sort key. It used to be impossible — `deleted_at` was outside the
   * shared field space, so the rows were ordered in the component over whatever page
   * came back — and the regression this pins is the silent one: if either engine loses
   * the root again, the order is wrong rather than refused.
   */
  it("sorts Trash by `deleted_at`, the root both engines now resolve", () => {
    expect(buildSort("deleted_at", "desc")).toEqual([{ field: "deleted_at", direction: "desc" }]);
    expect(isFieldPathShaped("deleted_at")).toBe(true);
    expect(TRASH_SORT_IS_CLIENT_SIDE).toBe(false);
  });
});

describe("buildEffectiveFilter", () => {
  /**
   * The split between this and `buildFilter` is the point: `buildFilter` answers "what
   * did the user ask for" (which decides between "no documents yet" and "nothing
   * matches your filter"), and this answers "what goes on the wire".
   */
  it("hides machine-owned documents when nothing else is filtered", () => {
    expect(buildEffectiveFilter({ combine: "and", clauses: [] })).toEqual(
      EXCLUDE_MACHINE_DOCUMENTS,
    );
    // …while the user's own filter is still empty, so the empty state stays "no
    // documents yet" rather than "nothing matches".
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

/**
 * `web/MOBILE-AUDIT.md`'s open question 5, settled.
 *
 * The claim: a row marked "this condition is not being applied" was applied anyway, and
 * the document list dropped to zero rows because of it. It was not true — the builder
 * has always dropped such a row — and the observation was the filter bar filling a
 * phone's first screen (audit item C-9) with the list below the fold, over an empty
 * state that said "No document matches **these conditions**" and so read as a claim the
 * conditions had run.
 *
 * Rather than record "we looked and it was fine", the property is pinned here: an
 * unusable row is worth exactly nothing to the query, alone or beside a good one, in
 * `and` and in `or`, with and without the machine-document exclusion.
 */
describe("an unusable clause contributes nothing to the query (MOBILE-AUDIT Q5)", () => {
  /** What the "Add condition" button produces: a field, an operator, an empty value. */
  const fresh = clause({ id: "fresh", value: "" });

  it("leaves the effective filter byte-identical to the draft without it", () => {
    const without = { combine: "and", clauses: [] } as const;
    const with_ = { combine: "and", clauses: [fresh] } as const;
    expect(buildEffectiveFilter(with_)).toEqual(buildEffectiveFilter(without));
    expect(buildEffectiveFilter(with_)).toEqual(EXCLUDE_MACHINE_DOCUMENTS);
    // Not an `and` of one, not an `all` node: the exclusion and nothing else.
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
    // `hasFilter` in `DocListView` is `buildFilter(...) !== undefined`, so this is what
    // decides between "No documents yet" and "No document matches".
    expect(buildFilter({ combine: "and", clauses: [fresh] })).toBeUndefined();
  });

  it("is reported to the row, with a reason rather than a guess", () => {
    expect(invalidClauses({ combine: "and", clauses: [fresh] })).toEqual(["fresh"]);
    expect(clauseProblem(fresh)).toBe("Type a value to compare against.");
    // Filled in and still refused — the two cases the old copy called "Incomplete".
    expect(clauseProblem(clause({ op: "text_contains", kind: "date", value: "2026-09-23" }))).toBe(
      "Text matching needs the text value type.",
    );
    expect(clauseProblem(clause({ op: "lt", kind: "bool", value: "true" }))).toBe(
      "Before and after do not apply to true/false or null.",
    );
  });
});

/**
 * The mark and the query are one decision, not two that have to be kept in step.
 *
 * This is the guard that would have caught the bug Q5 suspected, whichever direction it
 * had drifted: a row silently dropped, or a row marked dead while the query carried it.
 */
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
    // A matrix that never drops anything would pass the line above vacuously.
    expect(dropped).toBeGreaterThan(0);
  });

  it("says nothing about a row the valueless operators make complete on their own", () => {
    for (const op of VALUELESS_OPS) {
      expect(clauseProblem(clause({ op, value: "" }))).toBeUndefined();
    }
  });
});

describe("appliedCount", () => {
  /**
   * The number on the folded "Filters" toggle: the conditions the query carries, so a
   * half-typed row does not light a badge over a query with nothing in it.
   */
  it("counts what the query carries, not what the boxes hold", () => {
    expect(appliedCount({ combine: "and", clauses: [] })).toBe(0);
    // Showing machine documents is a filter like any other, so it counts.
    expect(appliedCount({ combine: "and", clauses: [], includeMachine: true })).toBe(1);
    expect(appliedCount({ combine: "and", clauses: [clause(), clause({ id: "b", value: "" })] })).toBe(1);
    expect(appliedCount({ combine: "and", clauses: [clause()], includeMachine: true })).toBe(2);
  });
});
