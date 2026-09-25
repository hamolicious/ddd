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
  buildClause,
  buildEffectiveFilter,
  buildFilter,
  buildLiteral,
  buildSort,
  invalidClauses,
  isFieldPathShaped,
  TRASH_SORT_IS_CLIENT_SIDE,
  type FilterClause,
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
    expect(buildFilter({ combine: "and", clauses: [], titleContains: "  " })).toBeUndefined();
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

  it("turns the title box into a case-insensitive text node", () => {
    expect(buildFilter({ combine: "and", clauses: [], titleContains: "Groceries" })).toEqual({
      text: { field: "title", mode: "contains", value: "Groceries" },
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
