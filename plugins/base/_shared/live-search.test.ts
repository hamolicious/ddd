import { createSearchApi, type FilterJson } from "@kernel";
import { describe, expect, it } from "vitest";

import { conditionOf, notMachine } from "./live-search.js";
import { EXCLUDE_MACHINE_DOCUMENTS } from "./machine-docs.js";

const search = createSearchApi({
  run: () => Promise.resolve({ rows: [] }),
  watch: () => Promise.reject(new Error("unused")),
});

const roundTrip = (filter: FilterJson): unknown =>
  (search.from().where((w) => conditionOf(w, filter)).plan().stages ?? [])[0];

describe("stored filters become builder calls", () => {
  it("keeps every operator and value", () => {
    const filters: FilterJson[] = [
      { cmp: { field: "fm.status", op: "eq", value: { str: "open" } } },
      { cmp: { field: "fm.n", op: "gte", value: { int: 3 } } },
      { cmp: { field: "fm.f", op: "lt", value: { float: 1.5 } } },
      { cmp: { field: "fm.done", op: "ne", value: { bool: true } } },
      { cmp: { field: "fm.due", op: "gt", value: { date: "2026-10-05" } } },
      { cmp: { field: "fm.note", op: "eq", value: "null" } },
      { in: { field: "id", values: [{ str: "a" }, { str: "b" }] } },
      { contains: { field: "fm.tags", value: { str: "x" } } },
      { contains_any: { field: "fm.tags", values: [{ str: "x" }, { int: 1 }] } },
      { any: { field: "fm.scores", op: "gt", value: { int: 2 } } },
      { every: { field: "fm.scores", op: "eq", value: { int: 2 } } },
      { missing: { field: "fm.a" } },
      { exists: { field: "fm.a" } },
      { is_null: { field: "fm.a" } },
      { text: { field: "title", mode: "starts_with", value: "Q" } },
      { child_of: { field: "id", of: "F", deep: true } },
      { parent_of: { field: "id", of: "C" } },
      { and: [{ or: [{ missing: { field: "fm.a" } }, { not: { exists: { field: "fm.b" } } }] }] },
    ];
    for (const filter of filters) expect(roundTrip(filter)).toEqual({ where: filter });
  });

  it("spells out the machine-document filter", () => {
    expect((search.from().where(notMachine).plan().stages ?? [])[0]).toEqual({ where: EXCLUDE_MACHINE_DOCUMENTS });
  });
});
