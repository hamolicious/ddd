import { describe, expect, it } from "vitest";

import { CLAUSE_TOGGLES, typeChoices } from "./conditions-editor.js";
import { fieldOption } from "./search-fields.js";

describe("fields as kernel.search knows them", () => {
  it("settles the type when the notes agree, ignoring nulls", () => {
    expect(fieldOption({ field: "fm.due", kinds: ["date", "null"], list: false, builtIn: false, documents: 4 })).toEqual({
      field: "fm.due",
      label: "due · 4 notes",
      kind: "date",
      list: false,
      sortable: true,
    });
  });

  it("offers every type when the notes disagree", () => {
    const option = fieldOption({ field: "fm.mixed", kinds: ["text", "reference"], list: false, builtIn: false, documents: 2 });
    expect(option.kind).toBeUndefined();
    expect(option.kinds).toEqual(["str", "doc"]);
  });

  it("names built-in fields, and does not sort lists or the text", () => {
    expect(fieldOption({ field: "updated_at", kinds: ["date"], list: false, builtIn: true })).toMatchObject({ label: "Updated", sortable: true });
    expect(fieldOption({ field: "content", kinds: ["text"], list: false, builtIn: true }).sortable).toBe(false);
    expect(fieldOption({ field: "fm.tags", kinds: ["text"], list: true, builtIn: false, documents: 1 })).toMatchObject({ list: true, sortable: false });
  });
});

describe("when the condition editor asks for a type", () => {
  const all = ["str", "int", "float", "bool", "date", "null", "doc"] as const;

  it("does not ask when the field's type is known", () => {
    expect(typeChoices(all, { field: "fm.due", label: "due", kind: "date", sortable: true }, "date")).toBeUndefined();
  });

  it("asks among the types the notes use when they disagree", () => {
    expect(typeChoices(all, { field: "fm.mixed", label: "mixed", kinds: ["str", "doc"], sortable: true }, "str")).toEqual(["str", "doc"]);
  });

  it("asks among every type for a field no note uses yet", () => {
    expect(typeChoices(all, undefined, "str")).toEqual(all);
  });

  it("asks when a saved condition disagrees with what the notes now hold", () => {
    expect(typeChoices(all, { field: "fm.due", label: "due", kind: "date", sortable: true }, "str")).toEqual(["str", "date"]);
  });

  it("never asks for comparisons without a value", () => {
    expect(typeChoices(undefined, undefined, "str")).toBeUndefined();
  });
});

describe("the toggles on a condition", () => {
  const base = { id: "c", field: "fm.status", op: "eq", kind: "str", value: "open" } as const;
  const shown = (clause: Parameters<(typeof CLAUSE_TOGGLES)[number]["applies"]>[0]) =>
    CLAUSE_TOGGLES.filter((toggle) => toggle.applies(clause)).map((toggle) => toggle.id);

  it("offers negate on every condition, and nested only on is-inside", () => {
    expect(shown(base)).toEqual(["negate"]);
    expect(shown({ ...base, field: "", op: "child_of", value: "01" })).toEqual(["negate", "deep"]);
  });

  it("each toggle reads and writes its own flag", () => {
    const deep = CLAUSE_TOGGLES.find((toggle) => toggle.id === "deep");
    expect(deep?.on({ ...base, op: "child_of", deep: true })).toBe(true);
    expect(deep?.set(false)).toEqual({ deep: false });
    expect(deep?.label(true)).toBe("Including nested notes: turn off");
  });
});
