import { describe, expect, it } from "vitest";

import type { NoteRow } from "./hierarchy.js";
import { settledMoves, withPendingMoves, type PendingPlace } from "./pending.js";

const note = (id: string, children: readonly string[] = []): NoteRow => ({ id, title: id, children });

describe("withPendingMoves", () => {
  const rows = [note("p", ["a", "b"]), note("q"), note("a"), note("b")];

  it("draws a note where it was asked to go", () => {
    const next = withPendingMoves(rows, new Map<string, PendingPlace>([["a", { parent: "q" }]]));
    expect(next.find((row) => row.id === "p")?.children).toEqual(["b"]);
    expect(next.find((row) => row.id === "q")?.children).toEqual(["a"]);
  });

  it("places it before a sibling", () => {
    const next = withPendingMoves(rows, new Map([["b", { parent: "p", before: "a" }]]));
    expect(next.find((row) => row.id === "p")?.children).toEqual(["b", "a"]);
  });

  it("takes it out of every list for the root", () => {
    const next = withPendingMoves(rows, new Map([["a", { parent: "" }]]));
    expect(next.find((row) => row.id === "p")?.children).toEqual(["b"]);
  });

  it("returns the rows untouched when nothing is pending", () => {
    expect(withPendingMoves(rows, new Map())).toBe(rows);
  });
});

describe("settledMoves", () => {
  it("settles once the projection shows the same parent", () => {
    const pending = new Map([["a", { parent: "q" }]]);
    expect(settledMoves([note("p", ["a"]), note("q"), note("a")], pending)).toEqual([]);
    expect(settledMoves([note("p"), note("q", ["a"]), note("a")], pending)).toEqual(["a"]);
  });

  it("waits for the order too when a sibling was named", () => {
    const pending = new Map([["b", { parent: "p", before: "a" }]]);
    expect(settledMoves([note("p", ["a", "b"]), note("a"), note("b")], pending)).toEqual([]);
    expect(settledMoves([note("p", ["b", "a"]), note("a"), note("b")], pending)).toEqual(["b"]);
  });

  it("drops a move whose note is gone", () => {
    expect(settledMoves([note("p")], new Map([["a", { parent: "p" }]]))).toEqual(["a"]);
  });
});
