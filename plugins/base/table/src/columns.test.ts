import { describe, expect, it } from "vitest";

import type { DocumentRow } from "@kernel";

import { DEFAULT_TABLE, cellText, clampRows, columnForKey, decodeColumns, tableFromOptions, tableOptions } from "./columns.js";

describe("a table's settings", () => {
  it("defaults to the title alone, ten rows at a time", () => {
    expect(tableFromOptions({})).toEqual(DEFAULT_TABLE);
    expect(tableOptions(DEFAULT_TABLE)).toEqual({});
  });

  it("round-trips its columns and rows, keeping other keys", () => {
    const table = { columns: ["fm.status", "updated_at"], rows: 25 };
    const options = tableOptions(table, { other: "x" });
    expect(options).toEqual({ other: "x", cols: "fm.status,updated_at", rows: "25" });
    expect(tableFromOptions(options)).toEqual(table);
  });

  it("drops unknown and repeated columns, and clamps the rows", () => {
    expect(decodeColumns("fm.status, nope ,fm.status,match")).toEqual(["fm.status", "match"]);
    expect(clampRows("0")).toBe(1);
    expect(clampRows(9999)).toBe(200);
    expect(clampRows("junk")).toBe(10);
  });

  it("takes a typed property as a column", () => {
    expect(columnForKey(" status ")).toBe("fm.status");
    expect(columnForKey("fm.a.b")).toBe("fm.a.b");
    expect(columnForKey("no spaces")).toBeUndefined();
  });

  it("shows a property's value, nested ones included", () => {
    const row = { fm: { status: "open", a: { b: "deep" } } } as unknown as DocumentRow;
    expect(cellText(row, "fm.status")).toBe("open");
    expect(cellText(row, "fm.a.b")).toBe("deep");
    expect(cellText(row, "fm.missing")).toBe("");
  });
});
