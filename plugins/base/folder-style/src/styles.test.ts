import { describe, expect, it } from "vitest";

import {
  contrast,
  followMove,
  normalizeColor,
  parseStyles,
  sameStyles,
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

describe("followMove", () => {
  const before = styles({
    work: { background: "#e03131" },
    "work/clients": { icon: "users" },
    workshop: { icon: "tools" },
    home: { icon: "home" },
  });

  it("carries a renamed folder's look and its subfolders', and nothing that merely shares a prefix", () => {
    expect(object(followMove(before, { from: "work", to: "archive/work" }))).toEqual({
      "archive/work": { background: "#e03131" },
      "archive/work/clients": { icon: "users" },
      workshop: { icon: "tools" },
      home: { icon: "home" },
    });
  });

  it("drops a deleted folder's look and moves its subfolders' to where its contents went", () => {
    expect(object(followMove(before, { from: "work", contentsTo: "" }))).toEqual({
      clients: { icon: "users" },
      workshop: { icon: "tools" },
      home: { icon: "home" },
    });
  });

  it("drops the whole subtree when the contents went to the Trash", () => {
    expect(object(followMove(before, { from: "work" }))).toEqual({
      workshop: { icon: "tools" },
      home: { icon: "home" },
    });
  });

  it("lets the moved look replace the one already at the destination", () => {
    const after = followMove(styles({ a: { icon: "star" }, b: { icon: "home" } }), { from: "a", to: "b" });
    expect(object(after)).toEqual({ b: { icon: "star" } });
  });

  it("changes nothing when nothing was under the folder", () => {
    expect(sameStyles(followMove(before, { from: "elsewhere", to: "x" }), before)).toBe(true);
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
