import { describe, expect, it } from "vitest";

import { childrenSpec } from "../../_shared/saved-view.js";

import { BOARD_OPTIONS, cardFields, noteText } from "./create.js";

const boardSpec = childrenSpec;

describe("new boards and cards", () => {
  it("starts a board with starter columns", () => {
    expect(BOARD_OPTIONS).toEqual({ columns: "todo,doing,done" });
  });

  it("writes whole notes, quoting only what must be", () => {
    expect(noteText("New board")).toBe("---\ntitle: New board\n---\n");
    expect(noteText("x", { status: "to do", rank: 2, done: false, n: "12" })).toContain("status: to do\nrank: 2\ndone: false\nn: '12'\n");
  });

  it("gives a new card its column and what the board's search asks of every note, and no rank property", () => {
    const spec = {
      ...boardSpec("01TICKETS"),
      filter: {
        combine: "and" as const,
        clauses: [
          { id: "a", field: "", op: "child_of", kind: "str", value: "01TICKETS" },
          { id: "b", field: "fm.type", op: "eq", kind: "str", value: "ticket" },
          { id: "c", field: "fm.points", op: "eq", kind: "int", value: "3" },
          { id: "d", field: "fm.team", op: "eq", kind: "str", value: "x", negate: true },
        ],
      },
    };
    expect(cardFields(spec, { field: "fm.status", value: "doing" })).toEqual({
      parent: "01TICKETS",
      fm: { type: "ticket", points: 3, status: "doing" },
    });
  });

  it("bakes in nothing but the column for an 'or' search, and no value for the 'No …' column", () => {
    const spec = { ...boardSpec("01T"), filter: { ...boardSpec("01T").filter, combine: "or" as const } };
    expect(cardFields(spec, { field: "fm.status", value: undefined })).toEqual({ fm: {} });
  });
});
