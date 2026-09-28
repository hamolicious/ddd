/**
 * The loader's ordering and skipping rules (SPEC §6.1, §6.4). These are the
 * decisions that turn one broken plugin into a notice instead of a blank app, so
 * they are tested as pure functions, without a DOM, a server or a module to import.
 */

import { describe, expect, it } from "vitest";

import { KERNEL_API_VERSION, type InstalledPlugin, type PluginManifest } from "@kernel";

import { resolveOrder, transitiveDependents } from "./order.js";

function plugin(
  id: string,
  options: {
    version?: string;
    kernel?: string;
    dependencies?: Record<string, string>;
    base?: boolean;
    state?: InstalledPlugin["state"];
    frontend?: boolean;
  } = {},
): InstalledPlugin {
  const manifest: PluginManifest = {
    id,
    version: options.version ?? "1.0.0",
    kernel: options.kernel ?? "^1.0",
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    ...(options.frontend === false ? {} : { frontend: { module: "frontend/index.mjs" } }),
  };
  return {
    manifest,
    baseUrl: `/plugins/${id}/${manifest.version}/`,
    state: options.state ?? "enabled",
    base: options.base ?? true,
  };
}

const ids = (plugins: readonly InstalledPlugin[]): readonly string[] =>
  plugins.map((p) => p.manifest.id);

describe("resolveOrder", () => {
  it("orders dependencies before dependents, deterministically", () => {
    const { order, skipped } = resolveOrder(
      [
        plugin("editor", { dependencies: { "document-surface": "^1.0", markdown: "^1.0" } }),
        plugin("document-surface", { dependencies: { router: "^1.0" } }),
        plugin("markdown", {}),
        plugin("router", { dependencies: { "shell-ui": "^1.0" } }),
        plugin("shell-ui", {}),
      ],
      { kernelVersion: KERNEL_API_VERSION },
    );

    expect(skipped).toEqual([]);
    const position = (id: string): number => ids(order).indexOf(id);
    expect(position("shell-ui")).toBeLessThan(position("router"));
    expect(position("router")).toBeLessThan(position("document-surface"));
    expect(position("document-surface")).toBeLessThan(position("editor"));
    expect(position("markdown")).toBeLessThan(position("editor"));
    // Stable across runs: ties break on id.
    expect(ids(order)).toEqual(ids(resolveOrder([...order].reverse(), { kernelVersion: KERNEL_API_VERSION }).order));
  });

  it("skips a plugin whose kernel range this bundle does not satisfy", () => {
    const { order, skipped } = resolveOrder([plugin("future", { kernel: "^2.0" })], {
      kernelVersion: "1.0.0",
    });
    expect(order).toEqual([]);
    expect(skipped[0]).toMatchObject({ pluginId: "future", reason: "kernel-mismatch" });
  });

  it("skips a dependent when its dependency is missing, and says which", () => {
    const { order, skipped } = resolveOrder([plugin("editor", { dependencies: { markdown: "^1.0" } })], {
      kernelVersion: KERNEL_API_VERSION,
    });
    expect(order).toEqual([]);
    expect(skipped[0]).toMatchObject({ pluginId: "editor", reason: "missing-dependency" });
    expect(skipped[0]?.detail).toContain("markdown");
  });

  it("skips a dependent when the installed dependency is the wrong major", () => {
    const { skipped } = resolveOrder(
      [plugin("editor", { dependencies: { markdown: "^2.0" } }), plugin("markdown", { version: "1.4.0" })],
      { kernelVersion: KERNEL_API_VERSION },
    );
    expect(skipped[0]).toMatchObject({ pluginId: "editor", reason: "dependency-version" });
  });

  it("propagates a skip transitively", () => {
    const { order, skipped } = resolveOrder(
      [
        plugin("a", { kernel: "^9.0" }),
        plugin("b", { dependencies: { a: "^1.0" } }),
        plugin("c", { dependencies: { b: "^1.0" } }),
      ],
      { kernelVersion: KERNEL_API_VERSION },
    );
    expect(order).toEqual([]);
    expect(skipped.map((s) => s.pluginId).sort()).toEqual(["a", "b", "c"]);
  });

  it("skips every plugin in a dependency cycle rather than guessing an order", () => {
    const { order, skipped } = resolveOrder(
      [plugin("a", { dependencies: { b: "^1.0" } }), plugin("b", { dependencies: { a: "^1.0" } })],
      { kernelVersion: KERNEL_API_VERSION },
    );
    expect(order).toEqual([]);
    expect(skipped.every((s) => s.reason === "cycle")).toBe(true);
  });

  it("ignores backend-only plugins without reporting a problem", () => {
    const { order, skipped } = resolveOrder([plugin("calendar", { frontend: false })], {
      kernelVersion: KERNEL_API_VERSION,
    });
    expect(order).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("safe mode loads the base distribution only", () => {
    const { order, skipped } = resolveOrder(
      [plugin("shell-ui", { base: true }), plugin("third-party", { base: false })],
      { kernelVersion: KERNEL_API_VERSION, baseOnly: true },
    );
    expect(ids(order)).toEqual(["shell-ui"]);
    expect(skipped[0]).toMatchObject({ pluginId: "third-party", reason: "disabled" });
  });

  it("does not load a plugin that is pending approval or disabled", () => {
    const { order } = resolveOrder([plugin("pending-one", { state: "pending" })], {
      kernelVersion: KERNEL_API_VERSION,
    });
    expect(order).toEqual([]);
  });
});

describe("transitiveDependents", () => {
  it("finds every plugin downstream of a failure", () => {
    const plugins = [
      plugin("markdown"),
      plugin("viewer", { dependencies: { markdown: "^1.0" } }),
      plugin("editor", { dependencies: { markdown: "^1.0" } }),
      plugin("tasks", { dependencies: { viewer: "^1.0" } }),
      plugin("unrelated"),
    ];
    expect([...transitiveDependents("markdown", plugins)].sort()).toEqual([
      "editor",
      "tasks",
      "viewer",
    ]);
    expect([...transitiveDependents("unrelated", plugins)]).toEqual([]);
  });
});

describe("the base distribution's order (PLUGIN-PROTOCOLS §9 step 4)", () => {
  it("is the one the server's resolver is pinned to", async () => {
    const { readFileSync, readdirSync, existsSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const base = resolve(repo, "plugins/base");
    const plugins = readdirSync(base)
      .filter((id) => existsSync(resolve(base, id, "manifest.json")))
      .map((id) => ({
        manifest: JSON.parse(readFileSync(resolve(base, id, "manifest.json"), "utf8")),
        baseUrl: `/plugins/${id}/1.0.0/`,
        state: "enabled" as const,
        base: true,
      }));
    const corpus = JSON.parse(readFileSync(resolve(repo, "backend/crates/core/corpus/wiring.json"), "utf8")) as {
      base_order: string[];
    };
    const result = resolveOrder(plugins, { kernelVersion: KERNEL_API_VERSION });
    expect(result.skipped).toEqual([]);
    expect(result.order.map((p) => p.manifest.id)).toEqual(corpus.base_order);
  });
});
