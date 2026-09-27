import { describe, expect, it } from "vitest";

import type { FmField, FmValueCount } from "../../_shared/indexer-api.js";

import { inFrontmatter, suggest, yamlScalar } from "./suggest.js";

const VALUES: Record<string, readonly FmValueCount[]> = {
  status: [
    { value: "open", count: 3 },
    { value: "done", count: 2 },
    { value: "reopened", count: 1 },
    { value: null, count: 1 },
  ],
  tags: [
    { value: "work", count: 4 },
    { value: "home", count: 2 },
    { value: "wishlist", count: 1 },
  ],
  priority: [{ value: 2, count: 1 }],
};
const field = (key: string, count: number, machineOnly = false): FmField => ({ key, count, machineOnly, kinds: {} });
const FIELDS: readonly FmField[] = [
  field("title", 9),
  field("status", 6),
  field("tags", 7),
  field("start", 2),
  field("project", 1),
  field("project.stage", 1),
  field("theme", 3, true),
];
const index = { fmFields: () => FIELDS, fmValues: (key: string) => VALUES[key] ?? [] };

/** Complete at the end of `doc` — the caret is after its last character. */
function at(doc: string) {
  const line = doc.slice(doc.lastIndexOf("\n") + 1);
  return suggest(line, doc, index);
}

describe("suggest — keys", () => {
  it("offers top-level keys this document does not have yet, most-used first", () => {
    const result = at("---\ntitle: x\nst");
    expect(result?.replace).toBe(2);
    expect(result?.items.map((item) => item.label)).toEqual(["status", "start"]);
    expect(result?.items[0]).toEqual({ label: "status", detail: "in 6 notes", insert: "status: " });
  });

  it("leaves out nested keys and ones only machine-owned documents use", () => {
    expect(at("---\nproj")?.items.map((item) => item.label)).toEqual(["project"]);
    expect(at("---\nthem")).toBeUndefined();
  });

  it("keeps offering a key typed in full, so Enter finishes it", () => {
    expect(at("---\nstatus")?.items[0]).toMatchObject({ label: "status", insert: "status: " });
  });

  it("needs a character: an empty line is where Enter makes room", () => {
    expect(at("---\ntitle: x\n")).toBeUndefined();
  });
});

describe("suggest — values", () => {
  it("offers a key's values, prefix matches first, then the rest that contain it", () => {
    const result = at("---\ntitle: x\nstatus: o");
    expect(result?.replace).toBe(1);
    expect(result?.items.map((item) => item.label)).toEqual(["open", "done", "reopened"]);
    expect(at("---\nstatus: re")?.items.map((item) => item.label)).toEqual(["reopened"]);
    expect(result?.items[0]).toEqual({ label: "open", detail: "3 notes", insert: "open" });
  });

  it("offers every value right after `key: `", () => {
    expect(at("---\nstatus: ")?.items.map((item) => item.label)).toEqual(["open", "done", "reopened"]);
  });

  it("stays shut once the value is complete, so Enter is a new line", () => {
    expect(at("---\nstatus: open")).toBeUndefined();
  });

  it("completes the item being typed in a flow list, skipping the ones there", () => {
    const result = at("---\ntags: [work, w");
    expect(result).toMatchObject({ replace: 1, items: [{ label: "wishlist" }] });
    expect(at("---\ntags: [work, home]")).toBeUndefined();
  });

  it("matches through an opening quote and replaces it", () => {
    expect(at('---\nstatus: "do')).toMatchObject({ replace: 3, items: [{ label: "done", insert: "done" }] });
  });

  it("answers only inside the frontmatter, on a key line, for a key with values", () => {
    expect(at("---\ntitle: x\n---\nstatus: o")).toBeUndefined();
    expect(at("status: o")).toBeUndefined();
    expect(at("---\n  status: o")).toBeUndefined();
    expect(at("---\nunknown: o")).toBeUndefined();
    expect(at("---\nstatus:o")).toBeUndefined();
  });

  it("writes non-strings as they are", () => {
    expect(at("---\npriority: ")?.items[0]?.insert).toBe("2");
  });
});

describe("inFrontmatter", () => {
  it.each([
    ["---\nk: v", true],
    ["﻿---\r\nk: v", true],
    ["---", false],
    ["---\nk: v\n---\nbody", false],
    ["# ---\nk: v", false],
  ])("%j → %s", (text, expected) => {
    expect(inFrontmatter(text)).toBe(expected);
  });
});

describe("yamlScalar", () => {
  it.each([
    ["open", "open"],
    ["in progress", "in progress"],
    ["2026-09-23", "2026-09-23"],
    ["123", '"123"'],
    ["true", '"true"'],
    ["a: b", '"a: b"'],
    ["x, y", '"x, y"'],
    ["#tag", '"#tag"'],
    ['say "hi"', '"say \\"hi\\""'],
  ])("%j → %s", (value, expected) => {
    expect(yamlScalar(value)).toBe(expected);
  });
});
