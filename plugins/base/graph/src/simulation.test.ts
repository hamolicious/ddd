import { describe, expect, it } from "vitest";

import { Simulation } from "./simulation.js";

const settle = (sim: Simulation, ticks = 400): void => {
  for (let i = 0; i < ticks; i += 1) sim.tick();
};

const distance = (sim: Simulation, a: string, b: string): number => {
  const p = sim.node(a)!;
  const q = sim.node(b)!;
  return Math.hypot(p.x - q.x, p.y - q.y);
};

describe("Simulation", () => {
  it("places every node at a distinct finite point", () => {
    const sim = new Simulation();
    sim.setGraph(
      Array.from({ length: 50 }, (_, i) => ({ id: `n${i}`, degree: 0 })),
      [],
    );
    const points = new Set(sim.nodes.map((node) => `${node.x},${node.y}`));
    expect(points.size).toBe(50);
    expect(sim.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it("settles linked nodes near the link distance, and cools", () => {
    const sim = new Simulation({ center: 0.5, repel: 10, link: 1, linkDistance: 100 });
    sim.setGraph([{ id: "a", degree: 1 }, { id: "b", degree: 1 }], [{ source: "a", target: "b" }]);
    settle(sim);
    expect(sim.running).toBe(false);
    expect(distance(sim, "a", "b")).toBeGreaterThan(60);
    expect(distance(sim, "a", "b")).toBeLessThan(200);
  });

  it("pushes unlinked nodes apart and keeps them near the middle", () => {
    const sim = new Simulation();
    sim.setGraph(Array.from({ length: 200 }, (_, i) => ({ id: `n${i}`, degree: 0 })), []);
    settle(sim);
    for (const node of sim.nodes) expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
    const nearest = Math.min(...sim.nodes.slice(1).map((node) => distance(sim, "n0", node.id)));
    expect(nearest).toBeGreaterThan(5);
    const far = Math.max(...sim.nodes.map((node) => Math.hypot(node.x, node.y)));
    expect(far).toBeLessThan(5000);
  });

  it("keeps a node where it was when the graph changes, and grows a new one beside its neighbour", () => {
    const sim = new Simulation();
    sim.setGraph([{ id: "a", degree: 0 }], []);
    const a = sim.node("a")!;
    a.x = 500;
    a.y = -300;
    sim.setGraph([{ id: "a", degree: 1 }, { id: "b", degree: 1 }], [{ source: "a", target: "b" }]);
    expect(sim.node("a")).toBe(a);
    expect(a.x).toBe(500);
    expect(distance(sim, "a", "b")).toBeLessThan(100);
  });

  it("holds a pinned node in place", () => {
    const sim = new Simulation();
    sim.setGraph([{ id: "a", degree: 1 }, { id: "b", degree: 1 }], [{ source: "a", target: "b" }]);
    const a = sim.node("a")!;
    a.fx = 42;
    a.fy = 7;
    settle(sim, 50);
    expect([a.x, a.y]).toEqual([42, 7]);
  });

  it("drops links to nodes it was not given", () => {
    const sim = new Simulation();
    sim.setGraph([{ id: "a", degree: 0 }], [{ source: "a", target: "zzz" }]);
    expect(sim.links).toEqual([]);
  });
});
