import { describe, expect, it } from "vitest";

import { byProximity, distanceFrom } from "./proximity.js";

//   root
//   ├── a
//   │   ├── a1
//   │   │   └── a1x
//   │   └── a2
//   └── b
//       └── b1
const parents: Record<string, string> = { a: "", a1: "a", a1x: "a1", a2: "a", b: "", b1: "b" };
const parentOf = (id: string): string | undefined => parents[id];

describe("distanceFrom", () => {
  const from = distanceFrom(parentOf, "a1");

  it("is 0 for the note itself", () => {
    expect(from("a1")).toBe(0);
  });

  it("is 1 for its parent and its children", () => {
    expect(from("a")).toBe(1);
    expect(from("a1x")).toBe(1);
  });

  it("is 2 for a sibling", () => {
    expect(from("a2")).toBe(2);
  });

  it("goes through the root for another branch", () => {
    expect(from("b")).toBe(3);
    expect(from("b1")).toBe(4);
  });

  it("puts a note the tree does not know at the root", () => {
    expect(from("stray")).toBe(3);
  });

  it("measures from the root as depth", () => {
    const root = distanceFrom(parentOf, "");
    expect(root("a")).toBe(1);
    expect(root("a1x")).toBe(3);
  });

  it("survives a cycle", () => {
    const loop = (id: string): string | undefined => ({ x: "y", y: "x" })[id];
    expect(distanceFrom(loop, "x")("y")).toBe(1);
  });
});

describe("byProximity", () => {
  it("sorts nearest first and keeps the order of ties", () => {
    const items = ["b1", "a2", "b", "a1x", "a"].map((id) => ({ id }));
    expect(byProximity(items, parentOf, "a1").map((item) => item.id)).toEqual(["a1x", "a", "a2", "b", "b1"]);
  });
});
