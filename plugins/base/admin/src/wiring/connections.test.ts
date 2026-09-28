import { describe, expect, it } from "vitest";

import type { PortCandidate, Resolution, WiringOverrides } from "@kernel";

import { AUTOMATIC, NONE, connectionRows } from "./connections.js";
import { EMPTY_OVERRIDES } from "./draft.js";
import type { Graph, Node, Port, Wire } from "./model.js";

const port = (plugin: string, name: string, dir: "in" | "out", kind: "service" | "slot" | "event", protocol: string, extra: Partial<Port> = {}): Port => ({
  key: `${plugin}:${name}`,
  plugin,
  name,
  dir,
  kind,
  protocol,
  version: dir === "in" ? "^1.0" : "1.0.0",
  side: (kind === "slot") === (dir === "in") ? "L" : "R",
  ...extra,
});
const node = (id: string, ports: readonly Port[]): Node => ({ id, version: "1.0.0", base: true, hot: true, name: id, description: "", ports });
const wire = (from: string, to: string, kind: "service" | "slot" | "event", extra: Partial<Wire> = {}): Wire => ({
  key: `${from} -> ${to}`,
  from,
  to,
  fromNode: from.split(":")[0] ?? "",
  toNode: to.split(":")[0] ?? "",
  kind,
  protocol: "lm/x",
  offerProtocol: "lm/x",
  ...extra,
});
const graphOf = (nodes: readonly Node[], wires: readonly Wire[]): Graph => ({
  nodes,
  byId: new Map(nodes.map((n) => [n.id, n])),
  ports: new Map(nodes.flatMap((n) => n.ports.map((p) => [p.key, p] as const))),
  wires,
  seatCount: {},
});
const resolution = (patch: Partial<Resolution> = {}): Resolution => ({
  order: [],
  skipped: [],
  wires: [],
  bindings: {},
  seats: {},
  bench: {},
  listeners: {},
  activation: [],
  diagnostics: [],
  status: {},
  ...patch,
});
const cand = (p: string, patch: Partial<PortCandidate> = {}): PortCandidate => ({ port: p, ok: true, same: true, auto: true, reasons: [], ...patch });

const graphNode = node("graph", [port("graph", "index", "in", "service", "lm/workspace-index"), port("graph", "view", "out", "slot", "lm/main.view")]);
const indexer = node("indexer", [port("indexer", "index", "out", "service", "lm/workspace-index")]);
const fuzzy = node("fuzzy", [port("fuzzy", "index", "out", "service", "lm/workspace-index")]);
const old = node("old", [port("old", "index", "out", "service", "lm/workspace-index")]);
const shell = node("shell-ui", [
  port("shell-ui", "sidebar", "in", "slot", "lm/sidebar.panel"),
  port("shell-ui", "header", "in", "slot", "lm/shell.header", { seats: 1 }),
  port("shell-ui", "views", "in", "slot", "lm/main.view"),
]);
const folders = node("folders", [port("folders", "tree", "out", "slot", "lm/sidebar.panel"), port("folders", "moved", "out", "event", "lm/folders.moved")]);
const docList = node("doc-list", [port("doc-list", "list", "out", "slot", "lm/sidebar.panel"), port("doc-list", "moved", "in", "event", "lm/folders.moved")]);
const outline = node("outline", [port("outline", "panel", "out", "slot", "lm/outline.panel")]);
const header = node("header", [port("header", "bar", "out", "slot", "lm/shell.header")]);
const alt = node("alt", [port("alt", "bar", "out", "slot", "lm/shell.header")]);

const wires: readonly Wire[] = [
  wire("indexer:index", "graph:index", "service"),
  wire("folders:tree", "shell-ui:sidebar", "slot", { seat: 1 }),
  wire("doc-list:list", "shell-ui:sidebar", "slot", { seat: 2 }),
  wire("alt:bar", "shell-ui:header", "slot", { seat: 1 }),
  wire("header:bar", "shell-ui:header", "slot", { bench: true }),
  wire("graph:view", "shell-ui:views", "slot", { seat: 1 }),
  wire("folders:moved", "doc-list:moved", "event"),
];
const graph = graphOf([graphNode, indexer, fuzzy, old, shell, folders, docList, outline, header, alt], wires);
const live = resolution({ bindings: { "graph:index": "indexer:index" }, status: { "graph:index": { code: "providers", count: 2 } } });

describe("a consumed service", () => {
  const candidates = {
    "graph:index": [
      cand("indexer:index"),
      cand("fuzzy:index"),
      cand("old:index", { ok: false, auto: false, reasons: ["missing connections"] }),
      cand("outline:panel", { same: false, ok: false, auto: false }),
    ],
  };

  it("shows the bound provider with Automatic selected, and every same-protocol candidate", () => {
    const [row] = connectionRows({ plugin: "graph", graph, resolution: live, draft: EMPTY_OVERRIDES, candidates }).uses;
    expect(row?.key).toBe("graph:index");
    expect(row?.protocol).toBe("lm/workspace-index@^1.0");
    expect(row?.bound).toBe("indexer:index");
    expect(row?.choice).toBe(AUTOMATIC);
    expect(row?.choices).toEqual([
      { value: AUTOMATIC, label: "Automatic" },
      { value: "fuzzy:index", label: "fuzzy:index" },
      { value: "indexer:index", label: "indexer:index" },
      { value: "old:index", label: "old:index", disabled: true, title: "missing connections" },
    ]);
    expect(row?.pills.map((p) => p.text)).toEqual(["service", "automatic", "2 providers"]);
  });

  it("selects a pin, offers None on an optional port, and keeps a missing pin visible", () => {
    const pinned: WiringOverrides = { ...EMPTY_OVERRIDES, bind: { "graph:index": "fuzzy:index" } };
    const status = resolution({ bindings: { "graph:index": "fuzzy:index" }, status: { "graph:index": { code: "pinned" } } });
    const [row] = connectionRows({ plugin: "graph", graph, resolution: status, draft: pinned, candidates }).uses;
    expect(row?.choice).toBe("fuzzy:index");
    expect(row?.pills.map((p) => p.text)).toEqual(["service", "pinned"]);

    const optional = graphOf([node("graph", [{ ...graphNode.ports[0]!, optional: true }]), indexer], []);
    const [free] = connectionRows({ plugin: "graph", graph: optional, resolution: resolution(), draft: { ...EMPTY_OVERRIDES, bind: { "graph:index": null } }, candidates }).uses;
    expect(free?.choice).toBe(NONE);
    expect(free?.choices?.at(-1)).toEqual({ value: NONE, label: "None" });
    expect(free?.bound).toBeUndefined();

    const gone: WiringOverrides = { ...EMPTY_OVERRIDES, bind: { "graph:index": "acme:index" } };
    const [missing] = connectionRows({ plugin: "graph", graph, resolution: live, draft: gone, candidates }).uses;
    expect(missing?.choices?.at(-1)).toEqual({ value: "acme:index", label: "acme:index · missing", disabled: true });
  });

  it("disables a candidate whose plugin the draft unplugs", () => {
    const draft = { ...EMPTY_OVERRIDES, unplugged: ["fuzzy"] };
    const [row] = connectionRows({ plugin: "graph", graph, resolution: live, draft, candidates }).uses;
    expect(row?.choices?.find((o) => o.value === "fuzzy:index")).toEqual({ value: "fuzzy:index", label: "fuzzy:index", disabled: true, title: "unplugged" });
  });
});

describe("a consumed slot", () => {
  const candidates = {
    "shell-ui:sidebar": [
      cand("folders:tree"),
      cand("doc-list:list"),
      cand("outline:panel", { same: false, auto: false }),
      cand("graph:view", { same: false, ok: false, auto: false }),
    ],
    "shell-ui:header": [cand("alt:bar"), cand("header:bar")],
  };
  const rows = connectionRows({ plugin: "shell-ui", graph, resolution: resolution(), draft: EMPTY_OVERRIDES, candidates }).uses;
  const byKey = new Map(rows.map((row) => [row.key, row]));

  it("lists its seats in order, and adds by shape only when the shape fits", () => {
    const sidebar = byKey.get("shell-ui:sidebar");
    expect(sidebar?.seats?.map((p) => [p.seat, p.port])).toEqual([
      [1, "folders:tree"],
      [2, "doc-list:list"],
    ]);
    expect(sidebar?.bench).toEqual([]);
    expect(sidebar?.add).toEqual([{ value: "outline:panel", label: "outline:panel · by shape", byShape: true, title: "lm/outline.panel → lm/sidebar.panel" }]);
    expect(sidebar?.pills.map((p) => p.text)).toEqual(["multi-seat"]);
  });

  it("keeps a single-seat host's bench apart", () => {
    const head = byKey.get("shell-ui:header");
    expect(head?.single).toBe(true);
    expect(head?.seats?.map((p) => p.port)).toEqual(["alt:bar"]);
    expect(head?.bench?.map((p) => [p.port, p.bench])).toEqual([["header:bar", true]]);
    expect(head?.add).toEqual([]);
    expect(head?.pills.map((p) => p.text)).toEqual(["1 seat"]);
  });

  it("groups rows by direction, sorted by name", () => {
    expect(rows.map((row) => row.name)).toEqual(["header", "sidebar", "views"]);
  });
});

describe("provided ports and events", () => {
  it("lists the hosts a provided slot feeds and adds other hosts, by shape after a confirm", () => {
    const candidates = {
      "folders:tree": [cand("shell-ui:sidebar"), cand("shell-ui:views", { same: false, auto: false })],
      "folders:moved": [cand("doc-list:moved"), cand("acme:moved", { same: false, auto: false })],
    };
    const { usedBy, uses } = connectionRows({ plugin: "folders", graph, resolution: resolution(), draft: EMPTY_OVERRIDES, candidates });
    expect(uses).toEqual([]);
    const [moved, tree] = usedBy;
    expect(tree?.peers?.map((p) => [p.port, p.seat])).toEqual([["shell-ui:sidebar", 1]]);
    expect(tree?.add).toEqual([{ value: "shell-ui:views", label: "shell-ui:views · by shape", byShape: true, title: "lm/sidebar.panel → lm/main.view" }]);
    // Events wire within one protocol id only.
    expect(moved?.peers?.map((p) => p.port)).toEqual(["doc-list:moved"]);
    expect(moved?.add).toEqual([]);
  });

  it("lists a consumed event's emitters", () => {
    const [moved] = connectionRows({ plugin: "doc-list", graph, resolution: resolution(), draft: EMPTY_OVERRIDES, candidates: {} }).uses;
    expect(moved?.peers?.map((p) => [p.port, p.wire])).toEqual([["folders:moved", "folders:moved -> doc-list:moved"]]);
    expect(moved?.add).toEqual([]);
  });

  it("returns nothing for a plugin the graph does not know", () => {
    expect(connectionRows({ plugin: "nope", graph, resolution: resolution(), draft: EMPTY_OVERRIDES, candidates: {} })).toEqual({ uses: [], usedBy: [] });
  });
});
