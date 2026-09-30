import { afterEach, describe, expect, it } from "vitest";

import { asPlugin, asPluginSync, withdrawFromRegistries } from "../../kernel/src/runtime/attribution.js";
import { ContractViolationError } from "./errors.js";
import { checked, createRegistry } from "./registry.js";
import { s } from "./shape.js";

interface Item {
  readonly id: string;
  readonly order?: number;
  readonly label?: string;
}

const make = () => createRegistry<Item>({ key: (i) => i.id, order: (i) => i.order ?? 100 });

afterEach(() => {
  // Registries are page-wide; keep one test's items out of the next.
  withdrawFromRegistries("header");
  withdrawFromRegistries("graph");
});

describe("createRegistry", () => {
  it("sorts by order, then insertion, and removes with the returned function", () => {
    const registry = make();
    const offA = registry.add({ id: "a.x", order: 20 });
    registry.add([{ id: "b.y" }, { id: "c.z", order: 5 }]);
    registry.add({ id: "d.w", order: 20 });
    expect(registry.get().map((i) => i.id)).toEqual(["c.z", "a.x", "d.w", "b.y"]);
    offA();
    offA();
    expect(registry.get().map((i) => i.id)).toEqual(["c.z", "d.w", "b.y"]);
  });

  it("replaces an item with the same key, and the old unregister leaves the new one", () => {
    const registry = make();
    const first = registry.add({ id: "a.x", label: "one" });
    registry.add({ id: "a.x", label: "two" });
    expect(registry.get()).toEqual([{ id: "a.x", label: "two" }]);
    first();
    expect(registry.get()).toEqual([{ id: "a.x", label: "two" }]);
  });

  it("subscribe fires immediately, then after every change, with a stable array between changes", () => {
    const registry = make();
    const seen: number[] = [];
    const off = registry.subscribe((values) => seen.push(values.length));
    expect(registry.get()).toBe(registry.get());
    const remove = registry.add({ id: "a.x" });
    remove();
    off();
    registry.add({ id: "b.y" });
    expect(seen).toEqual([0, 1, 0]);
  });

  it("attributes to the activating plugin, else the id prefix, else unknown", async () => {
    const registry = make();
    await asPlugin("header", () => registry.add({ id: "shell.toggle" }));
    registry.add({ id: "graph.view" });
    registry.add({ id: "nodot" });
    asPluginSync("kernel", () => registry.add({ id: "shell" }));
    expect(registry.entries().map((e) => [e.value.id, e.pluginId])).toEqual([
      ["shell.toggle", "header"],
      ["graph.view", "graph"],
      ["nodot", "unknown"],
      ["shell", "kernel"],
    ]);
  });

  it("withdraws a plugin's items from every registry", async () => {
    const one = make();
    const two = createRegistry<string>();
    await asPlugin("header", () => {
      one.add({ id: "x.1" });
      two.add("hello");
    });
    one.add({ id: "y.2" });
    withdrawFromRegistries("header");
    expect(one.get().map((i) => i.id)).toEqual(["y.2"]);
    expect(two.get()).toEqual([]);
  });

  it("validates items against its shape", () => {
    const registry = createRegistry<Item>({ shape: s.object({ id: s.string() }) });
    expect(() => registry.add({ id: 5 } as unknown as Item)).toThrow(ContractViolationError);
    expect(registry.get()).toEqual([]);
  });
});

describe("checked", () => {
  it("validates arguments and results", () => {
    const add = checked(s.fn([s.number(), s.number()], s.number()), function add(a: number, b: number) {
      return a + b;
    });
    expect(add(1, 2)).toBe(3);
    expect(() => (add as (a: unknown, b: unknown) => number)("1", 2)).toThrow(/add: argument 1: value: expected number, got string/);
    const liar = checked(s.fn([], s.string()), () => 5 as unknown as string);
    expect(() => liar()).toThrow(ContractViolationError);
  });

  it("checks a promised result when it settles", async () => {
    const ok = checked(s.fn([s.string()], s.promise(s.boolean())), async (id: string) => id.length > 0);
    await expect(ok("x")).resolves.toBe(true);
    const bad = checked(s.fn([], s.promise(s.boolean())), async () => "yes" as unknown as boolean);
    await expect(bad()).rejects.toThrow(ContractViolationError);
  });

  it("passes everything through when the shape names no arguments", () => {
    const echo = checked(s.func(), (value: unknown) => value);
    expect(echo(7)).toBe(7);
  });
});
