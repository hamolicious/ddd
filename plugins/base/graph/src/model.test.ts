import { describe, expect, it } from "vitest";

import { WorkspaceIndex } from "../../indexer/src/workspace-index.js";
import { row } from "../../indexer/src/rows.test-util.js";

import { buildGraph, DEFAULT_FILTER, neighbourhood, shapeKey } from "./model.js";

function source() {
  const index = new WorkspaceIndex();
  index.sync([
    row("A", "[b](doc://B) [b again](doc://B) ![c](doc://C) [gone](doc://Z) [trash](doc://T)", { title: "Alpha", path: "work/x" }),
    row("B", "[a](doc://A)", { title: "Beta", path: "work" }),
    row("C", "[d](doc://D)", { title: "Gamma", parent: "doc://A" }),
    row("D", "end", { title: "Delta", path: "home" }),
    row("L", "alone", { title: "Lone" }),
    row("T", "[a](doc://A)", { title: "Trashed" }, { deleted: true }),
    row("S", "[a](doc://A)", { path: ".settings" }),
  ]);
  return index;
}

const ids = (graph: { nodes: readonly { id: string }[] }) => graph.nodes.map((node) => node.id).sort();
const pairs = (graph: { links: readonly { source: string; target: string }[] }) =>
  graph.links.map((link) => `${link.source}>${link.target}`).sort();

describe("buildGraph", () => {
  it("draws one link per direction, merging kinds and counting references", () => {
    const graph = buildGraph(source());
    expect(ids(graph)).toEqual(["A", "B", "C", "D", "L"]);
    expect(pairs(graph)).toEqual(["A>B", "A>C", "B>A", "C>A", "C>D"]);
    expect(graph.links.find((link) => link.source === "A" && link.target === "B")).toMatchObject({ kinds: ["link"], weight: 2 });
    expect(graph.links.find((link) => link.source === "C" && link.target === "A")).toMatchObject({ kinds: ["frontmatter"] });
    expect(graph.nodes.find((node) => node.id === "A")?.degree).toBe(4);
  });

  it("leaves out machine-owned and trashed notes, and links into Trash", () => {
    const graph = buildGraph(source(), { ...DEFAULT_FILTER, showMissing: true });
    expect(ids(graph)).not.toContain("S");
    expect(ids(graph)).not.toContain("T");
  });

  it("adds missing targets only when asked", () => {
    const graph = buildGraph(source(), { ...DEFAULT_FILTER, showMissing: true });
    expect(graph.nodes.find((node) => node.id === "Z")).toMatchObject({ missing: true, degree: 1 });
  });

  it("hides orphans when asked", () => {
    expect(ids(buildGraph(source(), { ...DEFAULT_FILTER, showOrphans: false }))).toEqual(["A", "B", "C", "D"]);
  });

  it("filters by kind", () => {
    const graph = buildGraph(source(), { ...DEFAULT_FILTER, showEmbeds: false, showFrontmatter: false });
    expect(pairs(graph)).toEqual(["A>B", "B>A", "C>D"]);
  });

  it("searches titles and folders, keeping only links between matches", () => {
    const graph = buildGraph(source(), { ...DEFAULT_FILTER, search: "WORK" });
    expect(ids(graph)).toEqual(["A", "B"]);
    expect(pairs(graph)).toEqual(["A>B", "B>A"]);
  });
});

describe("neighbourhood", () => {
  it("reaches `depth` links out, both ways", () => {
    const whole = buildGraph(source());
    expect(ids(neighbourhood(whole, "D", 1))).toEqual(["C", "D"]);
    expect(ids(neighbourhood(whole, "D", 2))).toEqual(["A", "C", "D"]);
    expect(pairs(neighbourhood(whole, "D", 2))).toEqual(["A>C", "C>A", "C>D"]);
  });

  it("recounts degree inside the neighbourhood", () => {
    expect(neighbourhood(buildGraph(source()), "D", 1).nodes.find((node) => node.id === "C")?.degree).toBe(1);
  });

  it("keeps the centre when a filter hid it", () => {
    const hidden = buildGraph(source(), { ...DEFAULT_FILTER, showOrphans: false });
    expect(neighbourhood(hidden, "L", 1, source()).nodes).toEqual([
      { id: "L", title: "Lone", folder: "", missing: false, degree: 0 },
    ]);
  });
});

describe("shapeKey", () => {
  it("ignores titles and order, notices links", () => {
    const graph = buildGraph(source());
    const renamed = { ...graph, nodes: [...graph.nodes].reverse().map((node) => ({ ...node, title: "x" })) };
    expect(shapeKey(renamed)).toBe(shapeKey(graph));
    expect(shapeKey({ ...graph, links: graph.links.slice(1) })).not.toBe(shapeKey(graph));
  });
});
