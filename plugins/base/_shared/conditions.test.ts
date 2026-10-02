import { describe, expect, it } from "vitest";

import {
  CHILDREN_FIELD,
  buildClause,
  buildConditions,
  buildLiteral,
  clauseProblem,
  isFieldPathShaped,
  describeClause,
  referencedParents,
  treeToWatch,
  type FilterClause,
} from "./conditions.js";

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
    expect(buildLiteral("date", "2026-02-29")).toBeUndefined();
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
    expect(isFieldPathShaped("fm")).toBe(false);
    expect(isFieldPathShaped("title.sub")).toBe(false);
    expect(isFieldPathShaped("unknown")).toBe(false);
    expect(isFieldPathShaped("fm.a.b.c.d.e.f.g")).toBe(false);
    expect(isFieldPathShaped("fm.$where")).toBe(false);
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
    expect(buildClause(clause({ op: "text_contains", kind: "int", value: "3" }))).toBeUndefined();
    expect(buildClause(clause({ op: "gt", kind: "bool", value: "true" }))).toBeUndefined();
    expect(buildClause(clause({ op: "lt", kind: "null", value: "" }))).toBeUndefined();
    expect(buildClause(clause({ field: "nope" }))).toBeUndefined();
  });

  it("produces nothing for an incomplete row", () => {
    expect(buildClause(clause({ value: "" }))).toBeUndefined();
    expect(buildClause(clause({ kind: "date", value: "2026" }))).toBeUndefined();
  });
});

describe("list lookups", () => {
  it("contains any of is an or of contains, one per comma-separated value", () => {
    expect(buildClause(clause({ field: "fm.tags", op: "contains_any", value: "work, home" }))).toEqual({
      or: [
        { contains: { field: "fm.tags", value: { str: "work" } } },
        { contains: { field: "fm.tags", value: { str: "home" } } },
      ],
    });
    expect(buildClause(clause({ field: "fm.tags", op: "contains_any", value: "work," }))).toEqual({
      contains: { field: "fm.tags", value: { str: "work" } },
    });
  });

  it("refuses a value the type cannot hold, and says which", () => {
    const bad = clause({ field: "fm.scores", op: "contains_any", kind: "int", value: "1, x" });
    expect(buildClause(bad)).toBeUndefined();
    expect(clauseProblem(bad)).toContain('"x"');
    expect(clauseProblem(clause({ op: "contains_any", value: " , " }))).toBeDefined();
  });
});

describe("the folder tree", () => {
  const children = new Map([
    ["parent", ["a", "b"]],
    ["only", ["c"]],
    ["empty", []],
  ]);
  const context = { childrenOf: (id: string) => children.get(id) };

  it("parent of X is a contains on the children list, and ignores the field", () => {
    expect(buildClause(clause({ field: "", op: "parent_of", value: "x" }))).toEqual({
      contains: { field: CHILDREN_FIELD, value: { str: "x" } },
    });
  });

  it("child of X is an in over X's children, as last seen", () => {
    expect(buildClause(clause({ op: "child_of", value: "parent" }), context)).toEqual({
      in: { field: "id", values: [{ str: "a" }, { str: "b" }] },
    });
    expect(buildClause(clause({ op: "child_of", value: "only" }), context)).toEqual({
      in: { field: "id", values: [{ str: "c" }] },
    });
  });

  it("with deep, every note below X, and a loop in the lists is walked once", () => {
    const tree = new Map([
      ["root", ["a", "b"]],
      ["a", ["a1"]],
      ["a1", ["root", "a2"]],
    ]);
    const deep = { childrenOf: (id: string) => tree.get(id) };
    expect(buildClause(clause({ op: "child_of", value: "root", deep: true }), deep)).toEqual({
      in: { field: "id", values: ["a", "b", "a1", "a2"].map((str) => ({ str })) },
    });
    expect(buildClause(clause({ op: "child_of", value: "root" }), deep)).toEqual({
      in: { field: "id", values: [{ str: "a" }, { str: "b" }] },
    });
    expect(describeClause(clause({ op: "child_of", value: "root", deep: true }))).toBe("is anywhere inside root");
  });

  it("watches the named notes, or every note with children once one is deep", () => {
    const shallow = { combine: "and" as const, clauses: [clause({ op: "child_of", value: "x" })] };
    expect(treeToWatch(shallow)).toEqual(["x"]);
    expect(treeToWatch({ ...shallow, clauses: [...shallow.clauses, clause({ id: "2", op: "child_of", value: "y", deep: true })] })).toBe("all");
    expect(treeToWatch({ combine: "and", clauses: [clause({ op: "child_of", value: "", deep: true })] })).toEqual([]);
  });

  it("a parent with no children, or not seen yet, matches nothing rather than everything", () => {
    const nothing = { cmp: { field: "id", op: "eq", value: { str: "" } } };
    expect(buildClause(clause({ op: "child_of", value: "empty" }), context)).toEqual(nothing);
    expect(buildClause(clause({ op: "child_of", value: "unknown" }), context)).toEqual(nothing);
    expect(buildClause(clause({ op: "child_of", value: "parent" }))).toEqual(nothing);
  });

  it("needs a note, and nothing else", () => {
    expect(clauseProblem(clause({ field: "", op: "child_of", value: "" }))).toBe("Choose a note.");
    expect(clauseProblem(clause({ field: "", op: "child_of", value: "x" }))).toBeUndefined();
    expect(buildClause(clause({ op: "parent_of", value: " " }))).toBeUndefined();
  });

  it("lists the parents to watch, once each", () => {
    const conditions = {
      combine: "and" as const,
      clauses: [
        clause({ id: "1", op: "child_of", value: "b" }),
        clause({ id: "2", op: "child_of", value: "a" }),
        clause({ id: "3", op: "child_of", value: "b" }),
        clause({ id: "4", op: "parent_of", value: "c" }),
      ],
    };
    expect(referencedParents(conditions)).toEqual(["a", "b"]);
    expect(buildConditions({ combine: "and", clauses: [clause({ op: "child_of", value: "only" })] }, context)).toEqual({
      in: { field: "id", values: [{ str: "c" }] },
    });
  });
});

describe("a document value", () => {
  it("matches the doc:// link a frontmatter field holds", () => {
    expect(buildLiteral("doc", "01J8")).toEqual({ str: "doc://01J8" });
    expect(buildClause(clause({ field: "fm.parent", op: "eq", kind: "doc", value: "01J8" }))).toEqual({
      cmp: { field: "fm.parent", op: "eq", value: { str: "doc://01J8" } },
    });
    expect(buildClause(clause({ field: "fm.related", op: "contains", kind: "doc", value: "01J8" }))).toEqual({
      contains: { field: "fm.related", value: { str: "doc://01J8" } },
    });
  });

  it("needs a note, and has no order", () => {
    expect(clauseProblem(clause({ kind: "doc", value: "" }))).toBe("Choose a note.");
    expect(buildClause(clause({ op: "lt", kind: "doc", value: "01J8" }))).toBeUndefined();
    expect(clauseProblem(clause({ op: "lt", kind: "doc", value: "01J8" }))).toContain("document");
  });
});
