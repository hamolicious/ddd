import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import {
  NO_KEPT,
  appendRanks,
  columnsFor,
  filterChoices,
  filterFields,
  filterRows,
  bornWith,
  kanbanOptions,
  keepColumns,
  movable,
  planRanks,
  rankOf,
  settled,
  splitColumns,
  withKanban,
  withMoves,
  writableGroup,
  type Scalar,
} from "./layout.js";

const note = (id: string, fm: DocumentRow["fm"], plugins: DocumentRow["plugins"] = {}): DocumentRow =>
  ({ id, title: id, fm, plugins }) as DocumentRow;

describe("the board", () => {
  it("groups by status by default, and keeps defaults out of the options", () => {
    expect(kanbanOptions({})).toEqual({ group: "fm.status", columns: [], order: true, card: [{ kind: "title" }], lanes: "" });
    expect(withKanban(kanbanOptions({}), { other: "x", group: "fm.stage" })).toEqual({ other: "x" });
    expect(withKanban({ group: "fm.stage", columns: [{ value: "a" }, { value: "b" }], order: false, card: [{ kind: "title" }], lanes: "" }, {})).toEqual({
      group: "fm.stage",
      columns: "a,b",
      order: "none",
    });
    expect(kanbanOptions({ order: "none" }).order).toBe(false);
    // An older board named the property it kept the rank in: on, all the same.
    expect(kanbanOptions({ order: "fm.pos" }).order).toBe(true);
    expect(withKanban(kanbanOptions({ order: "fm.pos" }), { order: "fm.pos" })).toEqual({});
    expect(splitColumns(" todo, doing ,, todo,done ")).toEqual(["todo", "doing", "done"]);
  });

  it("puts named columns first, even empty, then the rest, then the notes without a value", () => {
    const columns = columnsFor(
      [note("a", { status: "doing" }), note("b", { status: "blocked" }), note("c", {}), note("d", { status: "archive" })],
      kanbanOptions({ columns: "todo,doing,done" }),
    );
    expect(columns.map((column) => column.key)).toEqual(["todo", "doing", "done", "archive", "blocked", undefined]);
    expect(columns.map((column) => column.cards.map((card) => card.id))).toEqual([[], ["a"], [], ["d"], ["b"], ["c"]]);
  });

  it("puts a list value's note in each of its columns, keeping the value's type", () => {
    const columns = columnsFor([note("a", { tags: ["x", "y"] }), note("b", { priority: 2 })], kanbanOptions({ group: "fm.tags" }));
    expect(columns.map((column) => column.key)).toEqual(["x", "y", undefined]);
    expect(columnsFor([note("b", { priority: 2 })], kanbanOptions({ group: "fm.priority" }))[0]?.value).toBe(2);
  });

  it("moves only cards whose value one splice can write", () => {
    expect(writableGroup("fm.status")).toBe(true);
    expect(writableGroup("fm.project.phase")).toBe(false);
    expect(writableGroup("created_at")).toBe(false);
    expect(movable(note("a", { tags: ["x"] }), "fm.tags")).toBe(false);
    expect(movable(note("a", { status: "x" }), "fm.status")).toBe(true);
  });
});

describe("order and moves", () => {
  it("orders cards by rank, the unranked after in the search's order", () => {
    const [column] = columnsFor(
      [note("a", { status: "x" }), note("b", { status: "x" }, { kanban: { rank: 2 } }), note("c", { status: "x" }, { kanban: { rank: 1 } }), note("d", { status: "x" })],
      kanbanOptions({}),
    );
    expect(column?.cards.map((card) => card.id)).toEqual(["c", "b", "a", "d"]);
  });

  it("keeps a column once seen, even when its last card leaves", () => {
    const settings = kanbanOptions({});
    const first = columnsFor([note("a", { status: "blocked" }), note("b", {})], settings);
    const kept = keepColumns(first, NO_KEPT);
    const later = columnsFor([note("a", { status: "done" }), note("b", { status: "done" })], settings, kept);
    expect(later.map((column) => column.key)).toEqual(["blocked", "done", undefined]);
  });

  it("ranks a dropped card between its neighbours, or renumbers when it must", () => {
    const ranked = [note("a", {}, { kanban: { rank: 1024 } }), note("b", {}, { kanban: { rank: 2048 } })];
    expect([...planRanks(ranked, 1, "x")]).toEqual([["x", 1536]]);
    expect([...planRanks(ranked, 0, "x")]).toEqual([["x", 0]]);
    expect([...planRanks(ranked, 2, "x")]).toEqual([["x", 3072]]);
    expect([...planRanks([], 0, "x")]).toEqual([["x", 1024]]);
    const unranked = [note("a", {}), note("b", {}, { kanban: { rank: 5 } })];
    expect([...planRanks(unranked, 1, "x")]).toEqual([
      ["a", 1024],
      ["x", 2048],
      ["b", 3072],
    ]);
  });

  it("puts a new card last: below the highest rank, or after the unranked by numbering the column afresh", () => {
    const ranked = [note("a", {}, { kanban: { rank: 3072 } }), note("b", {}, { kanban: { rank: 1024 } })];
    expect([...appendRanks(ranked, 0, "new")]).toEqual([["new", 4096]]);
    expect([...appendRanks(ranked, 2, "new")]).toEqual([["new", 6144]]);
    expect([...appendRanks([], 0, "new")]).toEqual([["new", 1024]]);
    const mixed = [note("a", {}, { kanban: { rank: 5 } }), note("b", {})];
    expect([...appendRanks(mixed, 1, "new")]).toEqual([
      ["a", 1024],
      ["b", 2048],
      ["new", 4096],
    ]);
    // Laid out again, the new card is at the bottom of its column.
    const [column] = columnsFor(
      [...mixed, note("new", {})].map((row) => ({ ...row, fm: { status: "x" }, plugins: { kanban: { rank: appendRanks(mixed, 0, "new").get(row.id) } } })) as DocumentRow[],
      kanbanOptions({}),
    );
    expect(column?.cards.map((card) => card.id)).toEqual(["a", "b", "new"]);
  });

  it("shows a pending move on a copy of the row, and knows when it has landed", () => {
    const settings = kanbanOptions({});
    const rows = [note("a", { status: "todo", other: 1 })];
    const moved = withMoves(rows, settings, new Map([["a", { group: { value: "done" }, rank: 5 }]]));
    expect(moved[0]?.fm).toEqual({ status: "done", other: 1 });
    expect(moved[0]?.plugins).toEqual({ kanban: { rank: 5 } });
    expect(settled(moved[0]!, settings, { rank: 5 })).toBe(true);
    expect(withMoves(rows, settings, new Map([["a", { group: { value: undefined } }]]))[0]?.fm).toEqual({ other: 1 });
    expect(settled(rows[0]!, settings, { group: { value: "todo" } })).toBe(true);
    expect(settled(rows[0]!, settings, { group: { value: "todo" }, rank: 1 })).toBe(false);
  });

  it("reads a card's rank from its own section only", () => {
    expect(rankOf(note("a", {}, { kanban: { rank: 7 } }))).toBe(7);
    expect(rankOf(note("a", { rank: 3 }, { kanban: { rank: 7 } }))).toBe(7);
    expect(rankOf(note("a", { rank: 3 }))).toBeUndefined();
    const [column] = columnsFor(
      [note("a", { status: "x" }, { kanban: { rank: 2 } }), note("b", { status: "x", rank: 1 }), note("c", { status: "x" }, { kanban: { rank: 1 } })],
      kanbanOptions({}),
    );
    expect(column?.cards.map((card) => card.id)).toEqual(["c", "a", "b"]);
  });
});

describe("the filter bar", () => {
  const rows = [
    note("a", { status: "x", project: "Beta", priority: 2 }),
    note("b", { status: "y", project: "alpha", tags: ["p", "q"] }),
    note("c", { status: "x", project: "Beta", priority: 10 }),
  ];

  it("offers every property the cards show, and each value once in natural order", () => {
    expect(filterFields(kanbanOptions({ card: "title,fm.project,!fm.priority,content" }))).toEqual(["fm.project", "fm.priority"]);
    expect(filterChoices(rows, "fm.project")).toEqual(["alpha", "Beta"]);
    expect(filterChoices(rows, "fm.priority")).toEqual([2, 10]);
    expect(filterChoices(rows, "fm.tags")).toEqual(["p", "q"]);
    expect(filterChoices(rows, "fm.none")).toEqual([]);
  });

  it("keeps the rows holding every chosen value, a list value by any of its items", () => {
    expect(filterRows(rows, new Map()).map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(filterRows(rows, new Map([["fm.project", "Beta"]])).map((row) => row.id)).toEqual(["a", "c"]);
    expect(filterRows(rows, new Map<string, Scalar>([["fm.project", "Beta"], ["fm.priority", 10]])).map((row) => row.id)).toEqual(["c"]);
    expect(filterRows(rows, new Map([["fm.tags", "q"]])).map((row) => row.id)).toEqual(["b"]);
  });

  it("gives a new card each filter's value, where a note can be given it", () => {
    expect(bornWith(new Map<string, Scalar>([["fm.project", "Beta"], ["fm.priority", 2], ["fm.a.b", "nested"]]))).toEqual({ project: "Beta", priority: 2 });
  });
});

import { parseColumns, serializeColumns, withColumn } from "./layout.js";

describe("column definitions", () => {
  it("stay a comma list while they are only values, and go to JSON once one has more", () => {
    expect(serializeColumns([{ value: "todo" }, { value: "done" }])).toBe("todo,done");
    const rich = [{ value: "doing", label: "In progress", color: "#1971c2" }, { value: "done", collapsed: true }];
    const stored = serializeColumns(rich);
    expect(stored.startsWith("[")).toBe(true);
    expect(parseColumns(stored)).toEqual(rich);
    expect(parseColumns("todo, doing")).toEqual([{ value: "todo" }, { value: "doing" }]);
  });

  it("drop junk: bad JSON, blank or repeated values, a colour that is not one", () => {
    expect(parseColumns("[nope")).toEqual([]);
    expect(parseColumns(JSON.stringify([{ v: "" }, { v: "a", c: "red" }, { v: "a" }, 3]))).toEqual([{ value: "a" }]);
  });

  it("show labels and fold, naming a column when it was not named", () => {
    const settings = kanbanOptions({ columns: JSON.stringify([{ v: "doing", l: "In progress" }]) });
    const columns = columnsFor([note("x", { status: "doing" }), note("y", { status: "done" })], settings);
    expect(columns[0]?.def?.label).toBe("In progress");
    expect(withColumn(settings, "done", { collapsed: true }).columns).toEqual([
      { value: "doing", label: "In progress" },
      { value: "done", collapsed: true },
    ]);
  });
});

import { forgetColumn, placeColumn, removeColumn } from "./layout.js";

describe("editing columns", () => {
  const defs = [{ value: "todo" }, { value: "doing" }, { value: "done" }];

  it("changes a column where it stands, or moves it", () => {
    expect(placeColumn(defs, "doing", { value: "doing", label: "In progress" }, 1).map((def) => def.label ?? def.value)).toEqual([
      "todo",
      "In progress",
      "done",
    ]);
    expect(placeColumn(defs, "todo", { value: "todo" }, 2).map((def) => def.value)).toEqual(["doing", "done", "todo"]);
  });

  it("renames, names a column that was not named, and adds a new one", () => {
    expect(placeColumn(defs, "doing", { value: "review" }, 1).map((def) => def.value)).toEqual(["todo", "review", "done"]);
    expect(placeColumn(defs, undefined, { value: "blocked" }, 3).map((def) => def.value)).toEqual(["todo", "doing", "done", "blocked"]);
    expect(placeColumn(defs, undefined, { value: "new" }, 0).map((def) => def.value)).toEqual(["new", "todo", "doing", "done"]);
  });

  it("removes a column, from the settings and from what the board keeps", () => {
    expect(removeColumn(defs, "doing").map((def) => def.value)).toEqual(["todo", "done"]);
    expect(forgetColumn({ keys: ["a", "b"], loose: true }, "a")).toEqual({ keys: ["b"], loose: true });
  });
});

import { sortCards, sortedSlot } from "./layout.js";

describe("a column's own sort", () => {
  const rows = [
    note("a", { due: "2026-03-01", points: 5, name: "item 10" }),
    note("b", { due: "2026-01-15", points: "12", name: "item 9" }),
    note("c", { name: "Item 2" }),
    note("d", { due: "2026-02-01", points: 1 }),
  ];
  const ids = (list: readonly DocumentRow[]): string[] => list.map((row) => row.id);

  it("sorts dates by time and numbers as numbers, the missing last either way", () => {
    expect(ids(sortCards(rows, { field: "fm.due", direction: "asc" }))).toEqual(["b", "d", "a", "c"]);
    expect(ids(sortCards(rows, { field: "fm.due", direction: "desc" }))).toEqual(["a", "d", "b", "c"]);
    expect(ids(sortCards(rows, { field: "fm.points", direction: "asc" }))).toEqual(["d", "a", "b", "c"]);
  });

  it("sorts text naturally, and by title", () => {
    expect(ids(sortCards(rows, { field: "fm.name", direction: "asc" }))).toEqual(["c", "b", "a", "d"]);
    expect(ids(sortCards(rows, { field: "title", direction: "desc" }))).toEqual(["d", "c", "b", "a"]);
  });

  it("lands a dropped card where the sort puts it, and keeps the sort in the column's settings", () => {
    const others = sortCards(rows.slice(0, 2), { field: "fm.due", direction: "asc" });
    expect(sortedSlot(others, rows[3]!, { field: "fm.due", direction: "asc" })).toBe(1);
    const stored = serializeColumns([{ value: "doing", sort: { field: "fm.due", direction: "desc" } }]);
    expect(parseColumns(stored)).toEqual([{ value: "doing", sort: { field: "fm.due", direction: "desc" } }]);
    expect(parseColumns(JSON.stringify([{ v: "x", s: "bogus field:up" }]))).toEqual([{ value: "x" }]);
  });
});

import { sinceField } from "./layout.js";

describe("when a card entered its column", () => {
  it("is kept beside the grouping property, when that can be written", () => {
    expect(sinceField("fm.status")).toBe("fm.status-since");
    expect(sinceField("fm.project.phase")).toBeUndefined();
    expect(sinceField("created_at")).toBeUndefined();
  });

  it("is shown with a pending move, and sorts a column oldest first", () => {
    const settings = kanbanOptions({});
    const [moved] = withMoves([note("a", { status: "todo" })], settings, new Map([["a", { group: { value: "done" }, since: "2026-09-29T10:00:00.000Z" }]]));
    expect(moved?.fm).toEqual({ status: "done", "status-since": "2026-09-29T10:00:00.000Z" });
    const cards = [note("new", { "status-since": "2026-09-29T10:00:00.000Z" }), note("old", { "status-since": "2026-09-01T10:00:00.000Z" }), note("never", {})];
    expect(sortCards(cards, { field: "fm.status-since", direction: "asc" }).map((card) => card.id)).toEqual(["old", "new", "never"]);
  });
});
