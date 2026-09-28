/**
 * Where every box goes (PLUGIN-PROTOCOLS §7, §10 "the layout holds still while you edit").
 *
 * Columns run from fewest dependants on the left to most on the right and are filled top
 * to bottom; the column assignment is computed on load, Apply and Tidy only. Between
 * those, `reflow` keeps every box in its column and re-stacks the heights, because a
 * multi-seat port grows its row for every seat and the boxes below have to move down.
 *
 * Every measurement is computed, not read from the DOM: a node's height follows from its
 * ports and their seats, so wires, seats and hit areas all agree with the boxes without a
 * layout pass, and the whole thing is unit-testable.
 */

import type { Node, Port, Side } from "./model.js";

export const NODE_W = 228;
export const GAP_X = 120;
export const GAP_Y = 28;
export const COLS = 6;
/** The title row. */
export const HEAD_H = 30;
/** The "← used by" / "uses →" caption above a group of ports. */
export const CAP_H = 14;
/** One port row. */
export const ROW = 20;
/** Extra height per additional seat on a multi-seat port. */
export const STEP = 9;
export const SEAT_R = 6;
/** Bottom padding. */
export const PAD_B = 6;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface PortGeometry {
  readonly port: Port;
  /** Offset of the row's top from the node's top. */
  readonly top: number;
  readonly height: number;
  /** Seats drawn on the port: one per wire plus the open one, or exactly one. */
  readonly seatTotal: number;
}

export interface NodeGeometry {
  readonly id: string;
  readonly height: number;
  readonly left: readonly PortGeometry[];
  readonly right: readonly PortGeometry[];
  readonly ports: ReadonlyMap<string, PortGeometry>;
}

/** How many seats a port row shows: `seats: 1` shows one, otherwise every seat plus an open one. */
export function seatTotal(port: Port, seatCount: Readonly<Record<string, number>>): number {
  if (port.kind !== "slot" || port.dir !== "in") return 1;
  return port.seats === 1 ? 1 : (seatCount[port.key] ?? 0) + 1;
}

export function nodeGeometry(node: Node, seatCount: Readonly<Record<string, number>>): NodeGeometry {
  const ports = new Map<string, PortGeometry>();
  const groups: Record<Side, PortGeometry[]> = { L: [], R: [] };
  let y = HEAD_H;
  for (const side of ["L", "R"] as const) {
    const own = node.ports.filter((port) => port.side === side);
    if (own.length === 0) continue;
    y += CAP_H;
    for (const port of own) {
      const total = seatTotal(port, seatCount);
      const height = ROW + STEP * (total - 1);
      const geometry: PortGeometry = { port, top: y, height, seatTotal: total };
      groups[side].push(geometry);
      ports.set(port.key, geometry);
      y += height;
    }
  }
  return { id: node.id, height: y + PAD_B, left: groups.L, right: groups.R, ports };
}

export interface Column {
  readonly ids: readonly string[];
  /** Dependant counts of the first and last box, for the column's label. */
  readonly lo: number;
  readonly hi: number;
}

export interface Layout {
  readonly columns: readonly Column[];
  readonly positions: Readonly<Record<string, Point>>;
}

/** Fewest dependants on the left, most on the right; columns filled top to bottom. */
export function layout(
  nodes: readonly Node[],
  heights: Readonly<Record<string, number>>,
  counts: Readonly<Record<string, number>>,
  cols = COLS,
): Layout {
  const sorted = [...nodes].sort((a, b) => (counts[a.id] ?? 0) - (counts[b.id] ?? 0) || a.id.localeCompare(b.id));
  const h = (node: Node): number => heights[node.id] ?? HEAD_H;
  const target = sorted.reduce((sum, node) => sum + h(node) + GAP_Y, 0) / cols;
  const groups: Node[][] = [[]];
  let y = 0;
  for (const node of sorted) {
    if (y > 0 && y + h(node) > target && groups.length < cols) {
      groups.push([]);
      y = 0;
    }
    (groups[groups.length - 1] as Node[]).push(node);
    y += h(node) + GAP_Y;
  }
  const positions: Record<string, Point> = {};
  const columns = groups
    .filter((group) => group.length > 0)
    .map((group, index) => {
      const x = index * (NODE_W + GAP_X);
      let yy = 0;
      for (const node of group) {
        positions[node.id] = { x, y: yy };
        yy += h(node) + GAP_Y;
      }
      return {
        ids: group.map((node) => node.id),
        lo: counts[(group[0] as Node).id] ?? 0,
        hi: counts[(group[group.length - 1] as Node).id] ?? 0,
      };
    });
  return { columns, positions };
}

/** Keep every box in its column; re-stack the heights so nothing overlaps. */
export function reflow(
  columns: readonly Column[],
  positions: Readonly<Record<string, Point>>,
  heights: Readonly<Record<string, number>>,
): Readonly<Record<string, Point>> {
  const out: Record<string, Point> = { ...positions };
  for (const column of columns) {
    let y = 0;
    for (const id of column.ids) {
      const x = positions[id]?.x ?? 0;
      out[id] = { x, y };
      y += (heights[id] ?? HEAD_H) + GAP_Y;
    }
  }
  return out;
}

export interface View {
  readonly x: number;
  readonly y: number;
  readonly k: number;
}

export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 2;

/** The bounding box of every node, with room for column labels above. */
export function bounds(positions: Readonly<Record<string, Point>>, heights: Readonly<Record<string, number>>): {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
} {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const [id, p] of Object.entries(positions)) {
    x1 = Math.min(x1, p.x - 12);
    y1 = Math.min(y1, p.y - 30);
    x2 = Math.max(x2, p.x + NODE_W);
    y2 = Math.max(y2, p.y + (heights[id] ?? HEAD_H));
  }
  if (!Number.isFinite(x1)) return { x1: 0, y1: 0, x2: NODE_W, y2: HEAD_H };
  return { x1, y1, x2, y2 };
}

/** The view that shows everything, centred. */
export function fit(positions: Readonly<Record<string, Point>>, heights: Readonly<Record<string, number>>, width: number, height: number): View {
  const b = bounds(positions, heights);
  const pad = 24;
  const k = Math.min(1.2, Math.max(MIN_ZOOM, Math.min((width - pad * 2) / (b.x2 - b.x1), (height - pad * 2) / (b.y2 - b.y1))));
  return { k, x: (width - (b.x2 - b.x1) * k) / 2 - b.x1 * k, y: (height - (b.y2 - b.y1) * k) / 2 - b.y1 * k };
}

/** Zoom by `factor` around a point in canvas pixels. */
export function zoomAt(view: View, factor: number, px: number, py: number): View {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
  return { k, x: px - (px - view.x) * (k / view.k), y: py - (py - view.y) * (k / view.k) };
}

// ---------------------------------------------------------------------------
// Wire geometry
// ---------------------------------------------------------------------------

/** Where a port's dot is, in world coordinates. */
export function portPoint(geometry: NodeGeometry, position: Point, port: PortGeometry): Point {
  return {
    x: port.port.side === "R" ? position.x + NODE_W : position.x,
    y: position.y + port.top + ROW / 2,
  };
}

/** The centre of seat `seat` (1-based) on a multi-seat port. */
export function seatPoint(position: Point, port: PortGeometry, seat: number): Point {
  return { x: position.x, y: position.y + port.top + ROW / 2 + STEP * (seat - 1) };
}

/** +1 for a dot on the right edge, -1 on the left: wires leave a dot outwards. */
export const outward = (side: Side): 1 | -1 => (side === "R" ? 1 : -1);

function control(a: Point, b: Point, sa: number, sb: number): readonly [Point, Point] {
  const dx = Math.max(60, Math.abs(b.x - a.x) * 0.45);
  return [
    { x: a.x + sa * dx, y: a.y },
    { x: b.x + sb * dx, y: b.y },
  ];
}

export function curve(a: Point, b: Point, sa: number, sb: number): string {
  const [c1, c2] = control(a, b, sa, sb);
  return `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`;
}

/** The point at `t` along the curve, for the seat number label. */
export function along(a: Point, b: Point, sa: number, sb: number, t: number): Point {
  const [c1, c2] = control(a, b, sa, sb);
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
    y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
  };
}
