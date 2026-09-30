import { describe, expect, it } from "vitest";

import { fieldValue, fillTokens, isKeyShaped, parseFields, sameFields, serializeFields, wanted, type AutoField } from "./fields.js";

const at = new Date(2026, 8, 29, 9, 5);
const field = (key: string, value = "", on: AutoField["on"] = "create"): AutoField => ({
  id: key,
  key,
  value,
  on,
  when: { combine: "and", clauses: [] },
});

describe("a property's value", () => {
  it("fills the placeholders from the moment it is added", () => {
    expect(fillTokens("{{date}} {{time}} {{now}}", at)).toBe("2026-09-29 09:05 2026-09-29T09:05");
  });

  it("is typed as YAML would read it", () => {
    expect(fieldValue("true", at)).toBe(true);
    expect(fieldValue("3", at)).toBe(3);
    expect(fieldValue("-1.5", at)).toBe(-1.5);
    expect(fieldValue('"3"', at)).toBe("3");
    expect(fieldValue("", at)).toBeNull();
    expect(fieldValue("open", at)).toBe("open");
    expect(fieldValue("[a, 2, {{date}}]", at)).toEqual(["a", 2, "2026-09-29"]);
    expect(fieldValue("[]", at)).toEqual([]);
  });
});

describe("which properties a note gets", () => {
  const fields = [field("status", "open"), field("created", "{{date}}"), field("reviewed", "false", "edit"), field("status", "done")];

  it("skips every key the note has, whatever its value", () => {
    expect(wanted(fields, { status: null }, true).map((each) => each.key)).toEqual(["created", "reviewed"]);
  });

  it("adds new-note properties only to a new note", () => {
    expect(wanted(fields, {}, false).map((each) => each.key)).toEqual(["reviewed"]);
  });

  it("takes the first of two with the same key", () => {
    expect(wanted(fields, {}, true).find((each) => each.key === "status")?.value).toBe("open");
  });

  it("never writes a key that is not one", () => {
    expect(isKeyShaped("due date")).toBe(true);
    for (const bad of ["", " x", "a:b", "#x", "-x", "a\nb"]) expect(isKeyShaped(bad)).toBe(false);
    expect(wanted([field("a:b", "x", "edit")], {}, true)).toEqual([]);
  });
});

describe("the stored list", () => {
  it("round-trips, conditions included", () => {
    const fields: AutoField[] = [
      field("status", "open"),
      {
        ...field("area", "work", "edit"),
        when: { combine: "or", clauses: [{ id: "c", field: "", op: "child_of", value: "01J", kind: "str", deep: true }] },
      },
    ];
    const back = parseFields(serializeFields(fields));
    expect(sameFields(back, fields)).toBe(true);
    expect(back[1]?.on).toBe("edit");
  });

  it("drops lines it cannot read", () => {
    expect(parseFields(["nope", JSON.stringify({ value: "x" }), 3, JSON.stringify({ key: "k" })])).toHaveLength(1);
    expect(parseFields("x")).toEqual([]);
  });
});
