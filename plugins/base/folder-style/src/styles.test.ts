import { describe, expect, it } from "vitest";

import {
  contrast,
  normalizeColor,
  parseDefaults,
  parseRules,
  parseStyles,
  resolveStyle,
  ruleLabel,
  sameRules,
  sameStyles,
  serializeRules,
  serializeStyles,
  textOn,
  withStyle,
  type FolderStyle,
} from "./styles.js";

const styles = (entries: Record<string, FolderStyle>) => new Map(Object.entries(entries));
const object = (map: ReadonlyMap<string, FolderStyle>) => Object.fromEntries(map);

describe("normalizeColor", () => {
  it("accepts three and six hex digits, with or without #", () => {
    expect(normalizeColor("#E03131")).toBe("#e03131");
    expect(normalizeColor("e03131")).toBe("#e03131");
    expect(normalizeColor(" #abc ")).toBe("#aabbcc");
  });

  it("refuses anything else", () => {
    for (const input of ["", "#abcd", "red", "#ggg000", undefined]) expect(normalizeColor(input)).toBeUndefined();
  });
});

describe("parseStyles / serializeStyles", () => {
  it("round-trips, sorted by path, paths with spaces included", () => {
    const stored = ["- book reading list", "#e03131 briefcase work", "#1971c2 - work/clients"];
    expect(serializeStyles(parseStyles(stored))).toEqual(stored);
  });

  it("drops what it cannot read and lets a later line win", () => {
    const parsed = parseStyles(["nonsense", 3, "#zzz folder a", "- Bad_Name b", "#abc - c", "- star c"]);
    expect(object(parsed)).toEqual({ a: { icon: "folder" }, c: { icon: "star" } });
  });

  it("reads anything that is not a list as nothing", () => {
    expect(parseStyles("#abc star home").size).toBe(0);
    expect(parseStyles(undefined).size).toBe(0);
  });
});

describe("withStyle", () => {
  it("lays a change over a style, clearing fields set to undefined", () => {
    expect(withStyle({ background: "#aaaaaa", icon: "star" }, { icon: undefined })).toEqual({ background: "#aaaaaa" });
    expect(withStyle({ background: "#aaaaaa" }, { icon: "home" })).toEqual({ background: "#aaaaaa", icon: "home" });
    expect(withStyle({ background: "#aaaaaa" }, { background: undefined })).toBeUndefined();
  });
});

describe("sameStyles", () => {
  it("compares every note's look", () => {
    const before = styles({ a: { icon: "star" }, b: { background: "#aaaaaa" } });
    expect(sameStyles(before, styles({ b: { background: "#aaaaaa" }, a: { icon: "star" } }))).toBe(true);
    expect(sameStyles(before, styles({ a: { icon: "star" } }))).toBe(false);
    expect(sameStyles(before, styles({ a: { icon: "home" }, b: { background: "#aaaaaa" } }))).toBe(false);
  });
});

describe("contrast / textOn", () => {
  it("measures the WCAG ratio", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrast("#1971c2", "#ffffff")).toBeCloseTo(5.02, 2);
  });

  it("picks whichever of black and white has the higher ratio", () => {
    for (const dark of ["#000000", "#1971c2", "#6741d9", "#c2255c"]) expect(textOn(dark)).toBe("#ffffff");
    for (const light of ["#ffffff", "#f59f00", "#2f9e44", "#868e96"]) expect(textOn(light)).toBe("#000000");
    // A close call is still a call: 4.65 against black, 4.51 against white.
    expect(textOn("#e03131")).toBe("#000000");
  });
});

describe("parseDefaults / resolveStyle", () => {
  it("reads the two settings, dropping what does not parse", () => {
    expect(parseDefaults("#ABC", "folder")).toEqual({ background: "#aabbcc", icon: "folder" });
    expect(parseDefaults("", "")).toEqual({});
    expect(parseDefaults("red", "Not An Icon")).toEqual({});
    expect(parseDefaults(undefined, null)).toEqual({});
  });

  it("fills each field a note leaves unset from the defaults", () => {
    const defaults = { background: "#868e96", icon: "note" };
    expect(resolveStyle(undefined, defaults)).toEqual(defaults);
    expect(resolveStyle({ icon: "briefcase" }, defaults)).toEqual({ background: "#868e96", icon: "briefcase" });
    expect(resolveStyle({ background: "#e03131", icon: "star" }, defaults)).toEqual({ background: "#e03131", icon: "star" });
  });

  it("is nothing when neither the note nor the defaults say anything", () => {
    expect(resolveStyle(undefined, {})).toBeUndefined();
    expect(resolveStyle({ icon: "star" }, {})).toEqual({ icon: "star" });
  });
});

describe("rules", () => {
  const line = JSON.stringify({
    when: { combine: "or", clauses: [{ field: "fm.tags", op: "contains", value: "work", kind: "str" }] },
    background: "#E03131",
    icon: "briefcase",
  });

  it("round-trips, row ids aside", () => {
    const rules = parseRules([line]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.when.combine).toBe("or");
    expect(rules[0]?.style).toEqual({ background: "#e03131", icon: "briefcase" });
    expect(serializeRules(rules)).toEqual([
      JSON.stringify({
        when: { combine: "or", clauses: [{ field: "fm.tags", op: "contains", value: "work", kind: "str" }] },
        background: "#e03131",
        icon: "briefcase",
      }),
    ]);
    expect(sameRules(rules, parseRules([line]))).toBe(true);
  });

  it("keeps a nested \"is inside\"", () => {
    const deep = JSON.stringify({ when: { combine: "and", clauses: [{ field: "", op: "child_of", value: "x", kind: "str", deep: true }] } });
    const rules = parseRules([deep]);
    expect(rules[0]?.when.clauses[0]?.deep).toBe(true);
    expect(serializeRules(rules)).toEqual([deep]);
  });

  it("keeps a name, trimmed, and labels an unnamed rule by its place", () => {
    const named = JSON.stringify({ name: "  Work  ", when: { combine: "and", clauses: [] } });
    const rules = parseRules([named, JSON.stringify({ name: " ", when: { combine: "and", clauses: [] } })]);
    expect(rules.map((rule, index) => ruleLabel(rule, index))).toEqual(["Work", "Rule 2"]);
    expect(serializeRules(rules)).toEqual([
      JSON.stringify({ name: "Work", when: { combine: "and", clauses: [] } }),
      JSON.stringify({ when: { combine: "and", clauses: [] } }),
    ]);
    // A name being typed, trailing space and all, is the stored one.
    expect(sameRules([{ ...rules[0]!, name: "Work " }], [rules[0]!])).toBe(true);
  });

  it("drops lines and clauses that do not parse", () => {
    const rules = parseRules([
      "not json",
      42,
      JSON.stringify({ background: "#fff" }),
      JSON.stringify({ when: { clauses: [{ field: "x", op: "explode", value: "", kind: "str" }, { field: "fm.a", op: "exists", value: "", kind: "str", negate: true }] } }),
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.when.combine).toBe("and");
    expect(rules[0]?.when.clauses.map((clause) => [clause.op, clause.negate])).toEqual([["exists", true]]);
    expect(rules[0]?.style).toEqual({});
  });

  it("never overrides the note's own look: own, then the first matching rule, then the default", () => {
    const defaults = { background: "#868e96", icon: "note" };
    const matched = [{ icon: "star" }, { background: "#e03131", icon: "flag" }];
    expect(resolveStyle(undefined, defaults, matched)).toEqual({ background: "#e03131", icon: "star" });
    expect(resolveStyle({ icon: "mine" }, defaults, matched)).toEqual({ background: "#e03131", icon: "mine" });
    expect(resolveStyle({ background: "#000000", icon: "mine" }, defaults, matched)).toEqual({
      background: "#000000",
      icon: "mine",
    });
    expect(resolveStyle(undefined, defaults, [{}])).toEqual(defaults);
  });
});
