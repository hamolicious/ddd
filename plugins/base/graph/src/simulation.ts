/**
 * A force-directed layout: the physics that makes the graph settle, and wobble when a
 * node is dragged. The same model as d3-force, written out so this plugin bundles
 * nothing:
 *
 * - **repel** — every node pushes every other away (Barnes–Hut over a quadtree, so a
 *   few thousand notes stay cheap);
 * - **link** — a spring on each link toward `linkDistance`, weaker on busy nodes so a hub
 *   does not drag its whole neighbourhood into a knot;
 * - **center** — a pull toward the origin, which keeps separate islands on screen.
 *
 * `alpha` is the temperature: every force is scaled by it and it decays toward
 * `alphaTarget`, so the layout cools and stops. Any change heats it back up. Pure apart
 * from `Math.random` for the jitter that separates coincident nodes.
 */

import type { DocumentId } from "@kernel";

export interface SimNode {
  readonly id: DocumentId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned (while dragged): the node is held here and its velocity ignored. */
  fx: number | undefined;
  fy: number | undefined;
  degree: number;
}

export interface SimLink {
  readonly source: SimNode;
  readonly target: SimNode;
}

export interface Forces {
  /** 0–1: how hard every node is pulled toward the middle. */
  readonly center: number;
  /** 0–20: how hard nodes push one another away. */
  readonly repel: number;
  /** 0–1: how stiff the links are. */
  readonly link: number;
  /** 30–500: the length a link settles at. */
  readonly linkDistance: number;
}

export const DEFAULT_FORCES: Forces = { center: 0.5, repel: 10, link: 1, linkDistance: 120 };

const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300);
const VELOCITY_DECAY = 0.4;
const THETA2 = 0.81;
/** Below this, repulsion is clamped: two nodes on top of each other must not fling apart. */
const DISTANCE_MIN2 = 1;

export class Simulation {
  nodes: SimNode[] = [];
  links: SimLink[] = [];
  alpha = 1;
  alphaTarget = 0;
  forces: Forces;
  readonly #byId = new Map<DocumentId, SimNode>();

  constructor(forces: Forces = DEFAULT_FORCES) {
    this.forces = forces;
  }

  node(id: DocumentId): SimNode | undefined {
    return this.#byId.get(id);
  }

  /** Still moving enough to be worth another frame. */
  get running(): boolean {
    return this.alpha >= ALPHA_MIN || this.alphaTarget > 0;
  }

  /**
   * Replace the graph, keeping every node that stays where it is. A new node starts next
   * to a neighbour that is already placed, so a link typed into a note grows a node out
   * of it rather than out of the middle of the screen.
   */
  setGraph(
    nodes: ReadonlyArray<{ readonly id: DocumentId; readonly degree: number }>,
    links: ReadonlyArray<{ readonly source: DocumentId; readonly target: DocumentId }>,
  ): void {
    const previous = new Map(this.#byId);
    this.#byId.clear();
    const fresh: SimNode[] = [];
    this.nodes = nodes.map((input) => {
      const kept = previous.get(input.id);
      const node: SimNode = kept ?? { id: input.id, x: NaN, y: NaN, vx: 0, vy: 0, fx: undefined, fy: undefined, degree: 0 };
      node.degree = input.degree;
      this.#byId.set(node.id, node);
      if (!kept) fresh.push(node);
      return node;
    });
    this.links = [];
    for (const link of links) {
      const source = this.#byId.get(link.source);
      const target = this.#byId.get(link.target);
      if (source && target && source !== target) this.links.push({ source, target });
    }

    // Place the new nodes: beside a placed neighbour when there is one, else on a spiral.
    const neighbours = new Map<SimNode, SimNode[]>();
    for (const { source, target } of this.links) {
      (neighbours.get(source) ?? neighbours.set(source, []).get(source)!).push(target);
      (neighbours.get(target) ?? neighbours.set(target, []).get(target)!).push(source);
    }
    let spiral = previous.size;
    for (const node of fresh) {
      const anchor = neighbours.get(node)?.find((other) => Number.isFinite(other.x));
      if (anchor) {
        const angle = Math.random() * Math.PI * 2;
        const distance = this.forces.linkDistance * 0.3;
        node.x = anchor.x + Math.cos(angle) * distance;
        node.y = anchor.y + Math.sin(angle) * distance;
      } else {
        // Phyllotaxis: evenly spread, no two on top of each other.
        const radius = 10 * Math.sqrt(0.5 + spiral);
        const angle = spiral * Math.PI * (3 - Math.sqrt(5));
        node.x = radius * Math.cos(angle);
        node.y = radius * Math.sin(angle);
        spiral += 1;
      }
    }
  }

  /** Heat the layout up to at least `alpha`. */
  reheat(alpha = 0.3): void {
    this.alpha = Math.max(this.alpha, alpha);
  }

  tick(): void {
    this.alpha += (this.alphaTarget - this.alpha) * ALPHA_DECAY;
    const alpha = this.alpha;
    this.#link(alpha);
    this.#repel(alpha);
    this.#center(alpha);
    for (const node of this.nodes) {
      if (node.fx !== undefined && node.fy !== undefined) {
        node.x = node.fx;
        node.y = node.fy;
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      node.vx *= 1 - VELOCITY_DECAY;
      node.vy *= 1 - VELOCITY_DECAY;
      node.x += node.vx;
      node.y += node.vy;
    }
  }

  #link(alpha: number): void {
    const strength = this.forces.link;
    if (strength <= 0) return;
    const distance = this.forces.linkDistance;
    for (const { source, target } of this.links) {
      let dx = target.x + target.vx - source.x - source.vx || jiggle();
      let dy = target.y + target.vy - source.y - source.vy || jiggle();
      const length = Math.sqrt(dx * dx + dy * dy);
      // d3's default: a link is as stiff as its less-connected end allows.
      const stiffness = strength / Math.max(1, Math.min(source.degree, target.degree));
      const pull = ((length - distance) / length) * alpha * stiffness;
      dx *= pull;
      dy *= pull;
      // The busier end moves less.
      const bias = source.degree / (source.degree + target.degree || 1);
      target.vx -= dx * bias;
      target.vy -= dy * bias;
      source.vx += dx * (1 - bias);
      source.vy += dy * (1 - bias);
    }
  }

  #repel(alpha: number): void {
    const strength = -this.forces.repel * 30;
    if (strength === 0 || this.nodes.length < 2) return;
    const tree = buildQuadtree(this.nodes);
    for (const node of this.nodes) applyRepulsion(tree, node, strength * alpha);
  }

  #center(alpha: number): void {
    const strength = this.forces.center * 0.1;
    if (strength <= 0) return;
    for (const node of this.nodes) {
      node.vx -= node.x * strength * alpha;
      node.vy -= node.y * strength * alpha;
    }
  }
}

function jiggle(): number {
  return (Math.random() - 0.5) * 1e-6;
}

// ---------------------------------------------------------------------------
// Barnes–Hut
// ---------------------------------------------------------------------------

interface Quad {
  x0: number;
  y0: number;
  size: number;
  /** Sum of the charges below, and their centre. */
  charge: number;
  cx: number;
  cy: number;
  /** A leaf holds nodes (more than one only when they coincide). */
  nodes: SimNode[] | undefined;
  children: (Quad | undefined)[] | undefined;
}

function buildQuadtree(nodes: readonly SimNode[]): Quad {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const node of nodes) {
    if (node.x < x0) x0 = node.x;
    if (node.y < y0) y0 = node.y;
    if (node.x > x1) x1 = node.x;
    if (node.y > y1) y1 = node.y;
  }
  const size = Math.max(x1 - x0, y1 - y0, 1);
  const root: Quad = { x0, y0, size, charge: 0, cx: 0, cy: 0, nodes: undefined, children: undefined };
  for (const node of nodes) insert(root, node, 0);
  accumulate(root);
  return root;
}

function insert(quad: Quad, node: SimNode, depth: number): void {
  if (!quad.children) {
    if (!quad.nodes) {
      quad.nodes = [node];
      return;
    }
    const first = quad.nodes[0]!;
    // Coincident, or deep enough that splitting further is pointless: share the leaf.
    if ((first.x === node.x && first.y === node.y) || depth > 32) {
      quad.nodes.push(node);
      return;
    }
    const held = quad.nodes;
    quad.nodes = undefined;
    quad.children = [undefined, undefined, undefined, undefined];
    for (const other of held) insertChild(quad, other, depth);
  }
  insertChild(quad, node, depth);
}

function insertChild(quad: Quad, node: SimNode, depth: number): void {
  const half = quad.size / 2;
  const right = node.x >= quad.x0 + half ? 1 : 0;
  const bottom = node.y >= quad.y0 + half ? 1 : 0;
  const index = bottom * 2 + right;
  let child = quad.children![index];
  if (!child) {
    child = {
      x0: quad.x0 + right * half,
      y0: quad.y0 + bottom * half,
      size: half,
      charge: 0,
      cx: 0,
      cy: 0,
      nodes: undefined,
      children: undefined,
    };
    quad.children![index] = child;
  }
  insert(child, node, depth + 1);
}

function accumulate(quad: Quad): void {
  let charge = 0;
  let cx = 0;
  let cy = 0;
  if (quad.nodes) {
    for (const node of quad.nodes) {
      charge += 1;
      cx += node.x;
      cy += node.y;
    }
  } else if (quad.children) {
    for (const child of quad.children) {
      if (!child) continue;
      accumulate(child);
      charge += child.charge;
      cx += child.cx * child.charge;
      cy += child.cy * child.charge;
    }
  }
  quad.charge = charge;
  quad.cx = charge ? cx / charge : 0;
  quad.cy = charge ? cy / charge : 0;
}

function applyRepulsion(quad: Quad, node: SimNode, strength: number): void {
  const dx = quad.cx - node.x;
  const dy = quad.cy - node.y;
  let d2 = dx * dx + dy * dy;

  // Far enough away: treat the whole quad as one charge at its centre.
  if (quad.children && (quad.size * quad.size) / THETA2 < d2) {
    if (d2 < DISTANCE_MIN2) d2 = Math.sqrt(DISTANCE_MIN2 * d2);
    node.vx += (dx * strength * quad.charge) / d2;
    node.vy += (dy * strength * quad.charge) / d2;
    return;
  }
  if (quad.children) {
    for (const child of quad.children) if (child) applyRepulsion(child, node, strength);
    return;
  }
  for (const other of quad.nodes ?? []) {
    if (other === node) continue;
    let ox = other.x - node.x;
    let oy = other.y - node.y;
    if (ox === 0) ox = jiggle();
    if (oy === 0) oy = jiggle();
    let o2 = ox * ox + oy * oy;
    if (o2 < DISTANCE_MIN2) o2 = Math.sqrt(DISTANCE_MIN2 * o2);
    node.vx += (ox * strength) / o2;
    node.vy += (oy * strength) / o2;
  }
}
