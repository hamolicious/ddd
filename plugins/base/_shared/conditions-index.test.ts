import { describe, expect, it } from "vitest";

import type { FmField } from "@protocols/lm/workspace-index";

import { indexNoteSource, indexSuggestions, inferKind, type ConditionIndex } from "./conditions-index.js";

const field = (key: string, kinds: FmField["kinds"], over: Partial<FmField> = {}): FmField => ({
  key,
  count: 2,
  machineOnly: false,
  kinds,
  ...over,
});
const values = (...list: (string | number | boolean | null)[]) => list.map((value) => ({ value, count: 1 }));

describe("inferKind", () => {
  it("takes the commonest kind, and a list the kind of its items", () => {
    expect(inferKind(field("status", { string: 3, null: 1 }), values("open"))).toBe("str");
    expect(inferKind(field("n", { number: 2 }), values(1, 2))).toBe("int");
    expect(inferKind(field("n", { number: 2 }), values(1, 2.5))).toBe("float");
    expect(inferKind(field("done", { boolean: 2 }), values(true))).toBe("bool");
    expect(inferKind(field("due", { date: 2 }), values("2026-09-01"))).toBe("date");
    expect(inferKind(field("tags", { array: 2 }), values("work", "home"))).toBe("str");
    expect(inferKind(field("scores", { array: 2 }), values(3, 4))).toBe("int");
    expect(inferKind(field("project", { map: 2 }), [])).toBeUndefined();
  });

  it("calls a field of doc:// links a document field", () => {
    expect(inferKind(field("parent", { string: 2 }), values("doc://a", "doc://b"))).toBe("doc");
    expect(inferKind(field("related", { array: 2 }), values("doc://a"))).toBe("doc");
    expect(inferKind(field("mixed", { string: 2 }), values("doc://a", "plain"))).toBe("str");
  });
});

describe("indexSuggestions", () => {
  const index: ConditionIndex = {
    fmFields: () => [
      field("tags", { array: 5 }, { count: 5 }),
      field("machine", { boolean: 1 }, { machineOnly: true }),
      field("project", { map: 1 }),
      field("status", { string: 1 }, { count: 1 }),
    ],
    fmValues: (key) => (key === "tags" ? values("work", null, "home") : key === "status" ? values("open") : []),
    documents: () => [
      { id: "1", title: "Work", folder: "", machine: false },
      { id: "2", title: "Homework", folder: "School", machine: false },
    ],
    subscribe: () => () => {},
    version: 1,
  };
  const suggestions = indexSuggestions(index);

  it("offers the fixed roots, then the keys a person wrote, with their type and whether they are lists", () => {
    const fm = suggestions.fields().filter((option) => option.field.startsWith("fm."));
    expect(fm.map((option) => [option.field, option.kind, option.list])).toEqual([
      ["fm.tags", "str", true],
      ["fm.status", "str", false],
    ]);
    expect(fm[1]?.label).toBe("status · 1 note");
    expect(suggestions.fields().some((option) => option.field === "title")).toBe(true);
  });

  it("offers a key's values, nulls left out, and none for a root", () => {
    expect(suggestions.values("fm.tags")).toEqual(["work", "home"]);
    expect(suggestions.values("title")).toEqual([]);
  });

  it("lists every note for the picker, with its folder and, when given, its look", () => {
    const source = indexNoteSource(index, { look: (id) => (id === "1" ? { background: "#000000" } : undefined), onChange: () => () => {} });
    expect(source.notes()).toEqual([
      { id: "1", title: "Work", folder: "" },
      { id: "2", title: "Homework", folder: "School" },
    ]);
    // The same answer while the index has not moved, so a memo keyed on it holds.
    expect(source.notes()).toBe(source.notes());
    expect(source.look?.("1")).toEqual({ background: "#000000" });
  });

});
