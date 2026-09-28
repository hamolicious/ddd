/**
 * The loader's ordering and skipping rules (SPEC §6.1, §6.4, PLUGIN-PROTOCOLS §6). The order
 * is the server's resolution; what this client adds is its own floor (a kernel range its
 * bundle does not implement) and the skips that follow from it. These are the decisions
 * that turn one broken plugin into a notice instead of a blank app, so they are tested as
 * pure functions, without a DOM, a server or a module to import.
 */

import { describe, expect, it } from "vitest";

import { KERNEL_API_VERSION, type InstalledPlugin, type PluginManifest, type Resolution } from "@kernel";
import { coreArtifactExists, loadCoreForNode } from "@kernel/wasm/node-core.js";

import { dependentsOf, orderFromResolution } from "./order.js";

function plugin(id: string, kernel = "^2.0"): InstalledPlugin {
  const manifest: PluginManifest = { id, version: "1.0.0", kernel, frontend: { module: "frontend/index.mjs" } };
  return { manifest, baseUrl: `/plugins/${id}/1.0.0/`, state: "enabled", base: true };
}

function resolution(
  order: readonly string[],
  requires: readonly [provider: string, consumer: string][] = [],
  skipped: Resolution["skipped"] = [],
): Resolution {
  return {
    order,
    skipped,
    wires: [],
    bindings: {},
    seats: {},
    bench: {},
    listeners: {},
    activation: requires.map(([provider, consumer]) => ({ provider, consumer, required: true })),
    diagnostics: [],
    status: {},
  };
}

const ids = (plugins: readonly InstalledPlugin[]): readonly string[] => plugins.map((p) => p.manifest.id);

describe("orderFromResolution", () => {
  it("activates in the server's order and passes its skips through", () => {
    const { order, skipped } = orderFromResolution(
      [plugin("a"), plugin("b"), plugin("c")],
      resolution(["c", "a", "b"], [], [{ plugin: "d", reason: "missing-service", detail: "index needs lm/workspace-index" }]),
      { kernelVersion: KERNEL_API_VERSION },
    );
    expect(ids(order)).toEqual(["c", "a", "b"]);
    expect(skipped).toEqual([{ pluginId: "d", reason: "missing-service", detail: "index needs lm/workspace-index" }]);
  });

  it("skips a plugin whose kernel range this bundle does not satisfy, and what requires it", () => {
    const { order, skipped } = orderFromResolution(
      [plugin("old", "^1.0"), plugin("user"), plugin("free")],
      resolution(["old", "free", "user"], [["old", "user"]]),
      { kernelVersion: KERNEL_API_VERSION },
    );
    expect(ids(order)).toEqual(["free"]);
    expect(skipped.map((s) => [s.pluginId, s.reason])).toEqual([
      ["old", "kernel-mismatch"],
      ["user", "service-skipped"],
    ]);
  });

  it("leaves out a resolved plugin this client did not accept, without a second report", () => {
    const { order, skipped } = orderFromResolution([plugin("b")], resolution(["a", "b"], [["a", "b"]]), {
      kernelVersion: KERNEL_API_VERSION,
    });
    expect(order).toEqual([]);
    expect(skipped).toEqual([{ pluginId: "b", reason: "service-skipped", detail: '"a" is not being loaded' }]);
  });
});

describe("dependentsOf", () => {
  it("follows required edges transitively and ignores optional ones", () => {
    const res = {
      ...resolution([], [
        ["markdown", "viewer"],
        ["viewer", "tasks"],
      ]),
      activation: [
        { provider: "markdown", consumer: "viewer", required: true },
        { provider: "viewer", consumer: "tasks", required: true },
        { provider: "markdown", consumer: "graph", required: false },
      ],
    };
    const out = dependentsOf(new Set(["markdown"]), res);
    expect([...out.keys()].sort()).toEqual(["tasks", "viewer"]);
    expect(out.get("tasks")).toBe("markdown");
  });
});

describe("the base distribution's order (PLUGIN-PROTOCOLS §9 step 4)", () => {
  it.skipIf(!coreArtifactExists())("is the one the server's resolver is pinned to", async () => {
    const { readFileSync, readdirSync, existsSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const base = resolve(repo, "plugins/base");
    const plugins: InstalledPlugin[] = readdirSync(base)
      .filter((id) => existsSync(resolve(base, id, "manifest.json")))
      .map((id) => ({
        manifest: JSON.parse(readFileSync(resolve(base, id, "manifest.json"), "utf8")) as PluginManifest,
        baseUrl: `/plugins/${id}/1.0.0/`,
        state: "enabled" as const,
        base: true,
      }));
    const protocols = readdirSync(base).flatMap((id) => {
      const dir = resolve(base, id, "protocols");
      if (!existsSync(dir)) return [];
      return readdirSync(dir).map((name) => JSON.parse(readFileSync(resolve(dir, name, "protocol.json"), "utf8")));
    });
    const corpus = JSON.parse(readFileSync(resolve(repo, "backend/crates/core/corpus/wiring.json"), "utf8")) as {
      base_order: string[];
    };
    // The same resolver the server runs natively, through the Wasm core.
    const core = await loadCoreForNode();
    const resolved = core.resolveWiring({
      plugins: plugins.map((p) => ({
        id: p.manifest.id,
        version: p.manifest.version,
        base: true,
        frontend: p.manifest.frontend !== undefined,
        ...(p.manifest.provides ? { provides: p.manifest.provides } : {}),
        ...(p.manifest.consumes ? { consumes: p.manifest.consumes } : {}),
      })),
      protocols,
      wiring: { unplugged: [], bind: {}, cut: [], add: [], order: {} },
    });
    expect(resolved.skipped).toEqual([]);
    expect(resolved.order).toEqual(corpus.base_order);
    const result = orderFromResolution(plugins, resolved, { kernelVersion: KERNEL_API_VERSION });
    expect(result.skipped).toEqual([]);
    expect(ids(result.order)).toEqual(corpus.base_order);
  });
});
