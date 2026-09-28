/**
 * The plugin runtime's hot apply (PLUGIN-PROTOCOLS §6c): the plan's order, restarts for
 * rebound services and upgrades, the reload fallback, and one apply at a time.
 *
 * The host is faked: what is under test is the runtime's bookkeeping and ordering. The
 * resolver itself is pinned by `backend/crates/core/corpus/wiring.json`.
 */

import { describe, expect, it } from "vitest";

import type { ApplyPlan, InstalledPlugin, LiveWiring, Resolution } from "@kernel";
import type { KernelHost } from "@kernel/runtime/index.js";

import type { ActiveModule } from "./loader.js";
import { PluginRuntime, type PluginSet } from "./runtime.js";

const wiring = (version: number): LiveWiring => ({ version, unplugged: [], bind: {}, cut: [], add: [], order: {} });

function plugin(id: string, options: { hot?: boolean; version?: string; peer?: Record<string, string> } = {}): InstalledPlugin {
  return {
    manifest: {
      id,
      version: options.version ?? "1.0.0",
      kernel: "^1.2",
      hot: options.hot ?? true,
      frontend: { module: "frontend/index.mjs" },
      ...(options.peer ? { peerLibraries: options.peer } : {}),
    },
    baseUrl: `/plugins/${id}/${options.version ?? "1.0.0"}/`,
    state: "enabled",
    base: true,
  };
}

function resolution(order: string[], activation: [string, string][] = []): Resolution {
  return {
    order,
    skipped: [],
    wires: [],
    bindings: {},
    seats: {},
    bench: {},
    listeners: {},
    activation: activation.map(([provider, consumer]) => ({ provider, consumer, required: true })),
    diagnostics: [],
    status: {},
  };
}

const emptyPlan: ApplyPlan = {
  changes: [],
  stop: [],
  start: [],
  restart: [],
  hosts: [],
  cold: [],
  alsoStops: [],
  alsoStarts: [],
  addedErrors: 0,
};

type PlanFake = Partial<ApplyPlan> | Error | ((request: { before: Resolution; after: Resolution }) => Partial<ApplyPlan>);

function harness(plugins: InstalledPlugin[], order: string[], plan: PlanFake) {
  const log: string[] = [];
  const active = new Map<string, ActiveModule>();
  const moduleFor = (id: string) => ({
    default: () => void log.push(`activate ${id}`),
    deactivate: () => void log.push(`deactivate ${id}`),
  });
  for (const id of order) active.set(id, { plugin: plugins.find((p) => p.manifest.id === id)!, module: moduleFor(id) });
  const configured: Resolution[] = [];
  const host = {
    core: {
      planWiring: (request: { before: Resolution; after: Resolution }) => {
        if (plan instanceof Error) throw plan;
        return { ...emptyPlan, ...(typeof plan === "function" ? plan(request) : plan) };
      },
    },
    ports: {
      configure: (config: { resolution: Resolution }) => void configured.push(config.resolution),
    },
    forPlugin: () => ({}),
    retract: (id: string) => void log.push(`retract ${id}`),
  } as unknown as KernelHost;
  const current: PluginSet = { plugins, wiring: wiring(1), resolution: resolution(order), protocols: [] };
  const runtime = new PluginRuntime({
    host,
    current,
    active,
    importModule: (url) => Promise.resolve(moduleFor(new URL(url, "http://x/").pathname.split("/")[2]!)),
    importMap: () => new Set(["react"]),
  });
  return { runtime, log, configured, active };
}

describe("hot apply", () => {
  it("stops in reverse activation order, rewires, then starts in activation order", async () => {
    const plugins = [plugin("a"), plugin("b"), plugin("c"), plugin("d")];
    const { runtime, log, configured } = harness(plugins, ["a", "b", "c"], {
      stop: ["c", "b"],
      start: ["d"],
      restart: ["a"],
    });
    const next = resolution(["a", "d"]);
    const outcome = await runtime.apply({ plugins, wiring: wiring(2), resolution: next, protocols: [] });

    expect(outcome.kind).toBe("applied");
    expect(log).toEqual([
      "deactivate c",
      "retract c",
      "deactivate b",
      "retract b",
      "deactivate a",
      "retract a",
      "activate a",
      "activate d",
    ]);
    expect(configured).toEqual([next]);
    expect(runtime.current.wiring.version).toBe(2);
    expect(runtime.active()).toEqual(["a", "d"]);
  });

  it("restarts an upgraded plugin and whatever uses it through services", async () => {
    const plugins = [plugin("lib"), plugin("app"), plugin("free")];
    const { runtime, log } = harness(plugins, ["lib", "app", "free"], {});
    const upgraded = [plugin("lib", { version: "1.1.0" }), plugin("app"), plugin("free")];
    await runtime.apply({ plugins: upgraded, wiring: wiring(2), resolution: resolution(["lib", "app", "free"], [["lib", "app"]]), protocols: [] });
    expect(log).toEqual(["deactivate app", "retract app", "deactivate lib", "retract lib", "activate lib", "activate app"]);
  });

  it("asks for a reload when a touched plugin is not hot, or the plan cannot be made", async () => {
    const plugins = [plugin("a"), plugin("cold", { hot: false })];
    const cold = harness(plugins, ["a", "cold"], { stop: ["cold"], cold: ["cold"] });
    const outcome = await cold.runtime.apply({ plugins, wiring: wiring(2), resolution: resolution(["a"]), protocols: [] });
    expect(outcome).toEqual({ kind: "reload", reasons: ["not hot-pluggable: cold"] });
    expect(cold.log).toEqual([]);
    expect(cold.runtime.current.wiring.version).toBe(1);

    const noCore = harness(plugins, ["a"], new Error("no Wasm"));
    expect((await noCore.runtime.apply({ plugins, wiring: wiring(2), resolution: resolution(["a"]), protocols: [] })).kind).toBe("reload");
  });

  it("asks for a reload when a starting plugin needs a library the import map lacks", async () => {
    const plugins = [plugin("a"), plugin("charts", { peer: { "chart.js": "^4.0.0" } })];
    const { runtime } = harness(plugins, ["a"], { start: ["charts"] });
    const outcome = await runtime.apply({ plugins, wiring: wiring(2), resolution: resolution(["a", "charts"]), protocols: [] });
    expect(outcome).toEqual({ kind: "reload", reasons: ["charts needs chart.js, which this page's import map lacks"] });
  });

  it("runs one apply at a time, in arrival order", async () => {
    const plugins = [plugin("a"), plugin("b")];
    // Like the real planner: what starts is what the new order has and the old one lacked.
    const { runtime, log } = harness(plugins, ["a"], ({ before, after }) => ({
      start: after.order.filter((id) => !before.order.includes(id)),
    }));
    const first = runtime.apply({ plugins, wiring: wiring(2), resolution: resolution(["a", "b"]), protocols: [] });
    const second = runtime.apply({ plugins, wiring: wiring(3), resolution: resolution(["a", "b"]), protocols: [] });
    await Promise.all([first, second]);
    expect(log.filter((line) => line === "activate b")).toHaveLength(1);
    expect(runtime.current.wiring.version).toBe(3);
  });
});
