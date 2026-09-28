import { describe, expect, it } from "vitest";

import { focusSet, neighboursOf, wireShown, type KindFilter, type Wire } from "./model.js";

const wire = (from: string, to: string, kind: Wire["kind"], extra: Partial<Wire> = {}): Wire => ({
  key: `${from} -> ${to}`,
  from,
  to,
  fromNode: from.split(":")[0] ?? "",
  toNode: to.split(":")[0] ?? "",
  kind,
  protocol: `lm/${kind}`,
  offerProtocol: `lm/${kind}`,
  ...extra,
});

const ALL: KindFilter = { service: true, slot: true, event: true };

// indexer provides a service to graph and fm-autocomplete; shell-ui hosts a slot indexer
// fills; graph also uses themes, which indexer never touches.
const wires: readonly Wire[] = [
  wire("indexer:index", "graph:index", "service"),
  wire("indexer:index", "fm-autocomplete:index", "service", { inactive: true }),
  wire("indexer:panel", "shell-ui:sidebar", "slot", { bench: true }),
  wire("indexer:changed", "search:changed", "event", { protocol: "lm/changed", offerProtocol: "lm/changed" }),
  wire("themes:theme", "graph:theme", "service"),
  wire("indexer:self", "indexer:loop", "event"),
];

describe("neighboursOf", () => {
  it("takes direct neighbours in both directions, inactive and benched wires included", () => {
    expect([...neighboursOf("indexer", wires)].sort()).toEqual(["fm-autocomplete", "graph", "search", "shell-ui"]);
    expect([...neighboursOf("graph", wires)].sort()).toEqual(["indexer", "themes"]);
  });

  it("stops at one hop and never lists the node itself", () => {
    expect(neighboursOf("themes", wires)).toEqual(new Set(["graph"]));
    expect(neighboursOf("indexer", wires).has("indexer")).toBe(false);
  });

  it("is empty for a node without wires", () => {
    expect(neighboursOf("lonely", wires).size).toBe(0);
  });
});

describe("focusSet", () => {
  it("is the node and its neighbours; a node with no wires focuses alone", () => {
    expect([...focusSet("indexer", wires, ALL, "")].sort()).toEqual(["fm-autocomplete", "graph", "indexer", "search", "shell-ui"]);
    expect(focusSet("lonely", wires, ALL, "")).toEqual(new Set(["lonely"]));
  });

  it("applies the kind chips", () => {
    expect([...focusSet("indexer", wires, { service: true, slot: false, event: false }, "")].sort()).toEqual(["fm-autocomplete", "graph", "indexer"]);
    expect([...focusSet("indexer", wires, { service: false, slot: true, event: false }, "")].sort()).toEqual(["indexer", "shell-ui"]);
  });

  it("applies the protocol filter, by either protocol of a wire", () => {
    expect([...focusSet("indexer", wires, ALL, "lm/changed")].sort()).toEqual(["indexer", "search"]);
    const byShape = [wire("a:out", "b:in", "slot", { protocol: "lm/need", offerProtocol: "lm/offer", byShape: true })];
    expect(focusSet("a", byShape, ALL, "lm/offer")).toEqual(new Set(["a", "b"]));
    expect(focusSet("a", byShape, ALL, "lm/other")).toEqual(new Set(["a"]));
  });
});

describe("wireShown", () => {
  it("needs the kind chip on and the protocol filter empty or matching", () => {
    const w = wire("a:x", "b:y", "event");
    expect(wireShown(w, ALL, "")).toBe(true);
    expect(wireShown(w, { ...ALL, event: false }, "")).toBe(false);
    expect(wireShown(w, ALL, "lm/event")).toBe(true);
    expect(wireShown(w, ALL, "lm/service")).toBe(false);
  });
});
