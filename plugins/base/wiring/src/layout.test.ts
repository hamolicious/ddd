import { describe, expect, it } from "vitest";

import { CAP_H, GAP_X, GAP_Y, HEAD_H, NODE_W, PAD_B, ROW, STEP, layout, nodeGeometry, reflow, seatPoint } from "./layout.js";
import { dependantCounts, type Node, type Port, type Wire } from "./model.js";

const port = (plugin: string, name: string, dir: "in" | "out", kind: "service" | "slot" | "event", extra: Partial<Port> = {}): Port => ({
  key: `${plugin}:${name}`,
  plugin,
  name,
  dir,
  kind,
  protocol: `lm/${name}`,
  version: "1.0.0",
  implicit: false,
  side: (kind === "slot") === (dir === "in") ? "L" : "R",
  ...extra,
});
const node = (id: string, ports: readonly Port[]): Node => ({ id, version: "1.0.0", base: true, hot: true, name: id, description: "", ports });
const wire = (from: string, to: string, kind: "service" | "slot" | "event", seat?: number): Wire => ({
  key: `${from} -> ${to}`,
  from,
  to,
  fromNode: from.split(":")[0] ?? "",
  toNode: to.split(":")[0] ?? "",
  kind,
  protocol: "lm/x",
  offerProtocol: "lm/x",
  ...(seat !== undefined ? { seat } : {}),
});

const shell = node("shell-ui", [port("shell-ui", "shell", "out", "service"), port("shell-ui", "sidebar", "in", "slot"), port("shell-ui", "header", "in", "slot", { seats: 1 })]);
const folders = node("folders", [port("folders", "tree", "out", "slot"), port("folders", "shell", "in", "service")]);
const docList = node("doc-list", [port("doc-list", "list", "out", "slot")]);
const header = node("header", [port("header", "bar", "out", "slot")]);

describe("nodeGeometry", () => {
  it("stacks the title, the two port groups and their rows, growing multi-seat rows", () => {
    const g = nodeGeometry(shell, { "shell-ui:sidebar": 2 });
    // Left: the service it provides and the two slots it hosts. Right: nothing.
    expect(g.left.map((p) => p.port.name)).toEqual(["shell", "sidebar", "header"]);
    expect(g.right).toEqual([]);
    const sidebar = g.ports.get("shell-ui:sidebar");
    expect(sidebar?.top).toBe(HEAD_H + CAP_H + ROW);
    expect(sidebar?.seatTotal).toBe(3);
    expect(sidebar?.height).toBe(ROW + STEP * 2);
    // A single-seat host shows one seat however many are wired.
    expect(g.ports.get("shell-ui:header")?.seatTotal).toBe(1);
    expect(g.height).toBe(HEAD_H + CAP_H + ROW + (ROW + STEP * 2) + ROW + PAD_B);
  });

  it("puts consumed services and provided slots on the right", () => {
    const g = nodeGeometry(folders, {});
    expect(g.left).toEqual([]);
    expect(g.right.map((p) => p.port.name)).toEqual(["tree", "shell"]);
    expect(g.height).toBe(HEAD_H + CAP_H + ROW * 2 + PAD_B);
  });

  it("places seats down the host's left edge, seat 1 at the top", () => {
    const g = nodeGeometry(shell, { "shell-ui:sidebar": 2 });
    const sidebar = g.ports.get("shell-ui:sidebar")!;
    const at = { x: 100, y: 50 };
    expect(seatPoint(at, sidebar, 1)).toEqual({ x: 100, y: 50 + sidebar.top + ROW / 2 });
    expect(seatPoint(at, sidebar, 2).y).toBe(50 + sidebar.top + ROW / 2 + STEP);
  });
});

describe("dependantCounts", () => {
  it("counts distinct dependants: slot contributors depend on the host, service consumers on the provider", () => {
    const wires = [
      wire("folders:tree", "shell-ui:sidebar", "slot", 1),
      wire("doc-list:list", "shell-ui:sidebar", "slot", 2),
      wire("shell-ui:shell", "folders:shell", "service"),
      wire("header:bar", "shell-ui:header", "slot", 1),
    ];
    expect(dependantCounts([shell, folders, docList, header], wires)).toEqual({ "shell-ui": 3, folders: 0, "doc-list": 0, header: 0 });
  });
});

describe("layout", () => {
  const nodes = [shell, folders, docList, header];
  const heights = { "shell-ui": 120, folders: 60, "doc-list": 50, header: 50 };
  const counts = { "shell-ui": 3, folders: 0, "doc-list": 0, header: 0 };

  it("runs columns from fewest dependants to most, filling top to bottom", () => {
    const out = layout(nodes, heights, counts, 2);
    // 280 of boxes plus four gaps is 392, so 196 per column: doc-list and folders fill
    // the first (78 + 88), header would overflow it and starts the second with shell-ui.
    expect(out.columns.map((c) => c.ids)).toEqual([
      ["doc-list", "folders"],
      ["header", "shell-ui"],
    ]);
    expect(out.columns[0]).toMatchObject({ lo: 0, hi: 0 });
    expect(out.columns[1]).toMatchObject({ lo: 0, hi: 3 });
    expect(out.positions["doc-list"]).toEqual({ x: 0, y: 0 });
    expect(out.positions["folders"]).toEqual({ x: 0, y: 50 + GAP_Y });
    expect(out.positions["header"]).toEqual({ x: NODE_W + GAP_X, y: 0 });
    expect(out.positions["shell-ui"]).toEqual({ x: NODE_W + GAP_X, y: 50 + GAP_Y });
  });

  it("reflow keeps every box in its column and re-stacks the heights", () => {
    const out = layout(nodes, heights, counts, 2);
    const grown = { ...heights, "doc-list": 90 };
    const moved = reflow(out.columns, out.positions, grown);
    expect(moved["doc-list"]).toEqual({ x: 0, y: 0 });
    expect(moved["folders"]).toEqual({ x: 0, y: 90 + GAP_Y });
    expect(moved["header"]).toEqual(out.positions["header"]);
    expect(moved["shell-ui"]).toEqual(out.positions["shell-ui"]);
  });
});
