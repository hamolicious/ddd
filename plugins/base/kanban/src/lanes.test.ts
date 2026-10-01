import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import { holds, keepLanes, laneChange, laneCount, laneScope, laneTitle, lanesFor } from "./lanes.js";
import { NO_KEPT, filterRows, kanbanOptions, settled, withMoves, type Scalar } from "./layout.js";

const note = (id: string, fm: DocumentRow["fm"]): DocumentRow => ({ id, title: id, fm, plugins: {} }) as DocumentRow;

const rows = [
  note("a", { status: "todo", team: "web" }),
  note("b", { status: "done", team: "API" }),
  note("c", { status: "todo" }),
  note("d", { status: "doing", team: "web" }),
  note("e", { status: "todo", team: ["web", "ops"] }),
];
const settings = kanbanOptions({ columns: "todo,doing,done", lanes: "fm.team" });
const ids = (list: readonly DocumentRow[]): string[] => list.map((row) => row.id);

describe("swimlanes", () => {
  it("are the board's columns, untouched, without a lane field", () => {
    const lanes = lanesFor(rows, kanbanOptions({ columns: "todo,doing,done" }));
    expect(lanes).toHaveLength(1);
    expect(lanes[0]?.key).toBeUndefined();
    expect(lanes[0]?.columns.map((column) => column.key)).toEqual(["todo", "doing", "done"]);
    expect(lanes[0]?.columns.every((column) => column.lane === undefined)).toBe(true);
  });

  it("are the field's values in natural order, a list value in each, the notes without one last", () => {
    const lanes = lanesFor(rows, settings);
    expect(lanes.map((lane) => lane.key)).toEqual(["API", "ops", "web", undefined]);
    expect(lanes.map((lane) => laneTitle(lane, settings.lanes))).toEqual(["API", "ops", "web", "No team"]);
    const web = lanes[2];
    expect(web?.columns.map((column) => ids(column.cards))).toEqual([["a", "e"], ["d"], []]);
    expect(web && laneCount(web)).toBe(3);
  });

  it("each have every column of the board, in the same order, knowing their lane", () => {
    const lanes = lanesFor([note("a", { status: "blocked", team: "web" }), note("b", { team: "api" })], kanbanOptions({ columns: "todo", lanes: "fm.team" }));
    for (const lane of lanes) expect(lane.columns.map((column) => column.key)).toEqual(["todo", "blocked", undefined]);
    expect(lanes[0]?.columns[0]?.lane).toEqual({ key: "api", value: "api" });
  });

  it("keep a lane once seen, and still show the columns with no card at all", () => {
    const first = lanesFor(rows, settings);
    const kept = keepLanes(first, NO_KEPT);
    const later = lanesFor([note("a", { status: "todo", team: "web" })], settings, NO_KEPT, kept);
    expect(later.map((lane) => lane.key)).toEqual(["API", "ops", "web", undefined]);
    const empty = lanesFor([], settings);
    expect(empty.map((lane) => lane.key)).toEqual([undefined]);
    expect(empty[0]?.columns.map((column) => column.key)).toEqual(["todo", "doing", "done"]);
    expect(keepLanes(empty, NO_KEPT)).toEqual({ keys: [], loose: false });
  });

  it("write the lane's value on a move into another lane, and nothing within one", () => {
    const lanes = lanesFor(rows, settings);
    const [api, , web, none] = lanes;
    const a = rows[0]!;
    expect(laneChange(a, web!.columns[1]!, settings.lanes)).toBeUndefined();
    expect(laneChange(a, api!.columns[0]!, settings.lanes)).toEqual({ value: "API" });
    expect(laneChange(a, none!.columns[0]!, settings.lanes)).toEqual({ value: undefined });
    // A list value stays in its lanes; a board without lanes changes none.
    expect(laneChange(rows[4]!, api!.columns[0]!, settings.lanes)).toBeNull();
    expect(laneChange(rows[4]!, web!.columns[1]!, settings.lanes)).toBeUndefined();
    expect(laneChange(a, lanesFor(rows, kanbanOptions({}))[0]!.columns[0]!, "")).toBeUndefined();
    // Nor can a nested key be written.
    expect(laneChange(note("x", { p: { q: "r" } }), { key: "s", value: "s", cards: [], lane: { key: "s", value: "s" } }, "fm.p.q")).toBeNull();
  });

  it("show a pending lane move, and know when it has landed", () => {
    const moved = withMoves([rows[0]!], settings, new Map([["a", { lane: { value: "API" } }]]));
    expect(moved[0]?.fm).toEqual({ status: "todo", team: "API" });
    expect(withMoves([rows[0]!], settings, new Map([["a", { lane: { value: undefined } }]]))[0]?.fm).toEqual({ status: "todo" });
    expect(settled(moved[0]!, settings, { lane: { value: "API" } })).toBe(true);
    expect(settled(rows[0]!, settings, { lane: { value: "API" } })).toBe(false);
    expect(holds(rows[2]!, "fm.team", undefined)).toBe(true);
    expect(holds(rows[4]!, "fm.team", "ops")).toBe(true);
  });

  it("are exactly the chosen ones under a filter on the lane field, without the 'No …' lane", () => {
    const filters = new Map<string, readonly Scalar[]>([["fm.team", ["web", "API"]]]);
    const kept = keepLanes(lanesFor(rows, settings), NO_KEPT);
    const lanes = lanesFor(filterRows(rows, filters), settings, NO_KEPT, kept, filters.get("fm.team"));
    expect(lanes.map((lane) => lane.key)).toEqual(["API", "web"]);
    expect(lanes[1]?.columns.map((column) => ids(column.cards))).toEqual([["a", "e"], ["d"], []]);
    // A chosen value no card holds is still its lane, to drop into or add to.
    const ghost = lanesFor(filterRows(rows, new Map([["fm.team", ["design"]]])), settings, NO_KEPT, kept, ["design"]);
    expect(ghost.map((lane) => [lane.key, lane.value, laneCount(lane)])).toEqual([["design", "design", 0]]);
    // No lane filter: as before.
    expect(lanesFor(rows, settings, NO_KEPT, NO_KEPT, []).map((lane) => lane.key)).toEqual(["API", "ops", "web", undefined]);
  });

  it("are kept for a drag, but not across a change of filter", () => {
    const none = laneScope("fm.team", new Map());
    expect(laneScope("fm.team", new Map())).toBe(none);
    expect(laneScope("fm.team", new Map([["fm.status", ["todo"]]]))).not.toBe(none);
    expect(laneScope("fm.other", new Map())).not.toBe(none);
    // The order the filters were chosen in, or a value's type, is no change.
    expect(laneScope("fm.team", new Map<string, readonly Scalar[]>([["a", [1]], ["b", ["x"]]]))).toBe(laneScope("fm.team", new Map([["b", ["x"]], ["a", ["1"]]])));
  });
});
