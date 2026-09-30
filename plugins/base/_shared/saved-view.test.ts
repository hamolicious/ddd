import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import {
  childrenSpec,
  newUlid,
  opensAs,
  optionEdits,
  savedSearchNoteText,
  sectionOptions,
  showsAs,
  typesOf,
} from "./saved-view.js";

const row = (fm: DocumentRow["fm"], plugins: DocumentRow["plugins"] = {}): DocumentRow =>
  ({ fm, plugins }) as DocumentRow;
const saved = (type?: DocumentRow["fm"][string]): DocumentRow =>
  row(type === undefined ? { "saved-search": "q=x" } : { "saved-search": "q=x", type });

describe("a saved search's types", () => {
  it("reads a string or a list, trimmed, lower-cased, each once", () => {
    expect(typesOf(saved(" Kanban "))).toEqual(["kanban"]);
    expect(typesOf(saved(["kanban", "Calendar", "kanban", 3, ""]))).toEqual(["kanban", "calendar"]);
  });

  it("is a table when it names none", () => {
    expect(typesOf(saved())).toEqual(["table"]);
    expect(typesOf(saved([]))).toEqual(["table"]);
  });

  it("shows every type it names, and opens in the first", () => {
    const note = saved(["kanban", "calendar"]);
    expect(showsAs(note, "kanban")).toBe(true);
    expect(showsAs(note, "calendar")).toBe(true);
    expect(showsAs(note, "table")).toBe(false);
    expect(opensAs(note, "kanban")).toBe(true);
    expect(opensAs(note, "calendar")).toBe(false);
  });

  it("is not a view of a note that is not a saved search", () => {
    expect(showsAs(row({ type: "kanban" }), "kanban")).toBe(false);
    expect(opensAs(row({ type: "kanban" }), "kanban")).toBe(false);
  });
});

describe("a view's settings", () => {
  it("are its section's scalar keys, as strings", () => {
    const note = row({}, { kanban: { columns: "a,b", limit: 5, on: true, list: ["x"], none: null }, table: { cols: "x" } });
    expect(sectionOptions(note, "kanban")).toEqual({ columns: "a,b", limit: "5", on: "true" });
    expect(sectionOptions(note, "calendar")).toEqual({});
  });

  it("change one line per changed key", () => {
    expect(optionEdits({ a: "1", b: "2", c: "3" }, { a: "1", b: "20", d: "4", c: "" })).toEqual([
      { key: "b", value: "20", remove: false },
      { key: "d", value: "4", remove: false },
      { key: "c", value: null, remove: true },
    ]);
    expect(optionEdits({ a: "1" }, { a: "1" })).toEqual([]);
  });
});

describe("a new saved search", () => {
  it("writes its title, search and type; several types as a list", () => {
    expect(savedSearchNoteText("a: b", "q=milk", ["kanban"])).toBe("---\ntitle: 'a: b'\nsaved-search: q=milk\ntype: kanban\n---\n");
    expect(savedSearchNoteText("x", "", ["kanban", "calendar"])).toContain("type:\n  - kanban\n  - calendar\n");
  });

  it("searches the notes inside it", () => {
    expect(childrenSpec("01BOARD").filter.clauses[0]).toMatchObject({ op: "child_of", value: "01BOARD" });
  });

  it("has a ULID: 26 Crockford characters, time first", () => {
    const id = newUlid(0x0183_4f5e_7a00, (bytes) => bytes.fill(31));
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id.slice(10)).toBe("Z".repeat(16));
    expect(newUlid(1) < newUlid(2)).toBe(true);
  });
});
