/**
 * The loader's failure rules (SPEC §6.4, `@kernel` 3.0) — the part of boot that decides
 * whether one broken plugin is a notice or a blank app:
 *
 * - plugins activate in the server's order (`load.normal` / `load.safe`), and are imported
 *   **only** by their `plugin:<id>` specifier;
 * - an import or `activate()` throw marks the plugin **failed**, withdraws what it
 *   registered, and **skips every plugin that depends on it**, transitively (those are
 *   never even imported);
 * - the loader re-validates every manifest itself, so a stale offline client refuses a
 *   plugin its bundle cannot honour instead of failing in pieces;
 * - registry items added while a plugin is imported or activated are attributed to it;
 * - the outcome is **one** aggregated notice.
 *
 * The host is faked, except for its `plugins` member, which is the real `PluginsHost`:
 * `loadPlugins` touches `forPlugin`, `plugins` and `retract`, the real `KernelHost` needs a
 * DOM and a sync client, and what is under test is the loader's bookkeeping.
 */

import { describe, expect, it, vi } from "vitest";

import { KERNEL_API_VERSION, createRegistry, type InstalledPlugin, type Kernel, type PluginManifest } from "@kernel";
import { PluginsHost, withdrawFromRegistries, type KernelHost } from "@kernel/runtime/index.js";

import { failureNotice, loadPlugins, moduleUrl, styleUrl, type LoadOptions } from "./loader.js";

interface Recorded {
  readonly host: KernelHost;
  readonly forPlugin: string[];
  readonly retracted: string[];
}

/** The members of `KernelHost` the loader uses, and nothing else. */
function fakeHost(): Recorded {
  const forPlugin: string[] = [];
  const retracted: string[] = [];
  const plugins = new PluginsHost(async () => ({}));
  const host = {
    plugins,
    forPlugin: (manifest: PluginManifest) => {
      forPlugin.push(manifest.id);
      return { pluginId: manifest.id, manifest, plugins: plugins.forPlugin(manifest) } as unknown as Kernel;
    },
    retract: (id: string) => {
      retracted.push(id);
      withdrawFromRegistries(id);
    },
  } as unknown as KernelHost;
  return { host, forPlugin, retracted };
}

function plugin(
  id: string,
  options: {
    version?: string;
    kernel?: string;
    style?: string;
    assetsVersion?: string;
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    provides?: string;
    frontend?: boolean;
  } = {},
): InstalledPlugin {
  const manifest: PluginManifest = {
    id,
    version: options.version ?? "1.0.0",
    kernel: options.kernel ?? "^3.0",
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    ...(options.optionalDependencies ? { optionalDependencies: options.optionalDependencies } : {}),
    ...(options.provides ? { provides: options.provides } : {}),
    ...(options.frontend === false
      ? {}
      : { frontend: { module: "frontend/index.mjs", ...(options.style ? { style: options.style } : {}) } }),
  };
  return {
    manifest,
    baseUrl: `/plugins/${id}/${manifest.version}/`,
    state: "enabled",
    base: true,
    ...(options.assetsVersion ? { assetsVersion: options.assetsVersion } : {}),
  };
}

type Modules = Readonly<Record<string, Record<string, unknown> | ((kernel: Kernel) => unknown)>>;

async function load(
  plugins: readonly InstalledPlugin[],
  modules: Modules,
  extra: Partial<LoadOptions> = {},
): Promise<Recorded & { report: Awaited<ReturnType<typeof loadPlugins>>; imported: string[] }> {
  const recorded = fakeHost();
  const imported: string[] = [];
  const report = await loadPlugins({
    host: recorded.host,
    plugins,
    kernelVersion: KERNEL_API_VERSION,
    order: plugins.map((p) => p.manifest.id),
    importModule: async (specifier) => {
      imported.push(specifier);
      const id = specifier.replace(/^plugin:/, "");
      const entry = modules[id];
      if (entry === undefined) throw new Error(`no module for ${specifier}`);
      return typeof entry === "function" ? { default: entry } : entry;
    },
    ...extra,
  });
  return { ...recorded, report, imported };
}

describe("activating in the server's order", () => {
  it("imports each module by its plugin: specifier, hands each plugin its own kernel, in order", async () => {
    const seen: string[] = [];
    const { report, imported, forPlugin } = await load(
      [plugin("shell-ui"), plugin("router", { dependencies: { "shell-ui": "^1.0" } })],
      {
        "shell-ui": (kernel) => void seen.push(kernel.pluginId),
        router: (kernel) => void seen.push(kernel.pluginId),
      },
    );
    expect(imported).toEqual(["plugin:shell-ui", "plugin:router"]);
    expect(forPlugin).toEqual(["shell-ui", "router"]);
    expect(seen).toEqual(["shell-ui", "router"]);
    expect(report.activated).toEqual(["shell-ui", "router"]);
    expect(report.failed).toEqual([]);
  });

  it("reports the server's skips as problems", async () => {
    const { report } = await load([plugin("a")], { a: () => undefined }, {
      serverSkipped: [{ id: "graph", reason: 'depends on "indexer" ^9.0, which is 2.0.0' }],
    });
    expect(report.skipped).toEqual([
      { pluginId: "graph", reason: "unresolved", detail: 'depends on "indexer" ^9.0, which is 2.0.0' },
    ]);
    expect(failureNotice(report)?.detail).toContain("graph: ");
  });

  it("awaits an async activate before starting the next", async () => {
    const events: string[] = [];
    await load([plugin("a"), plugin("b")], {
      a: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push("a done");
      },
      b: () => void events.push("b start"),
    });
    expect(events).toEqual(["a done", "b start"]);
  });

  it("reports progress per plugin", async () => {
    const progress: string[] = [];
    await load([plugin("a"), plugin("b")], { a: () => undefined, b: () => { throw new Error("no"); } }, {
      onProgress: (p) => progress.push(`${p.pluginId}:${p.outcome}:${p.index}/${p.total}`),
    });
    expect(progress).toEqual(["a:activated:0/2", "b:failed:1/2"]);
  });

  it("marks plugins active as they go, stand-ins under the id they provide", async () => {
    let sawEditor: boolean | undefined;
    const { host } = await load(
      [plugin("alt-editor", { provides: "editor@2.0.0" }), plugin("notes", { dependencies: { editor: "^2.0" } })],
      {
        "alt-editor": () => undefined,
        notes: (kernel) => void (sawEditor = kernel.plugins.active("editor")),
      },
    );
    expect(sawEditor).toBe(true);
    expect(host.plugins.active("alt-editor")).toBe(true);
    expect(host.plugins.list().map((p) => p.id)).toEqual(["alt-editor", "notes"]);
  });

  it("counts a backend-only plugin as present without importing anything", async () => {
    const { report, imported } = await load(
      [plugin("hooks", { frontend: false }), plugin("ui", { dependencies: { hooks: "^1.0" } })],
      { ui: () => undefined },
    );
    expect(imported).toEqual(["plugin:ui"]);
    expect(report.activated).toEqual(["hooks", "ui"]);
  });

  it("skips a plugin the page's import map cannot resolve, and its dependents", async () => {
    const { report, imported } = await load(
      [plugin("a"), plugin("b", { dependencies: { a: "^1.0" } })],
      { a: () => undefined, b: () => undefined },
      { available: (id) => id !== "a" },
    );
    expect(imported).toEqual([]);
    expect(report.skipped.map((s) => [s.pluginId, s.reason])).toEqual([
      ["a", "unavailable"],
      ["b", "dependency-failed"],
    ]);
  });

  it("skips an id the order names but the list does not have", async () => {
    const { report } = await load([plugin("a")], { a: () => undefined }, { order: ["ghost", "a"] });
    expect(report.activated).toEqual(["a"]);
    expect(report.skipped).toEqual([expect.objectContaining({ pluginId: "ghost", reason: "unavailable" })]);
  });
});

describe("a plugin that fails", () => {
  it("is retracted, and every plugin that depends on it, transitively, is skipped unimported", async () => {
    const { report, imported, retracted } = await load(
      [
        plugin("core"),
        plugin("settings", { dependencies: { core: "^1.0" } }),
        plugin("header", { dependencies: { settings: "^1.0" } }),
        plugin("icons"),
        plugin("graph", { dependencies: { icons: "^1.0" }, optionalDependencies: { settings: "^1.0" } }),
      ],
      {
        core: () => undefined,
        settings: () => {
          throw new Error("boom");
        },
        header: () => undefined,
        icons: () => undefined,
        graph: () => undefined,
      },
    );
    expect(report.failed.map((f) => [f.pluginId, f.error.message])).toEqual([["settings", "boom"]]);
    expect(retracted).toEqual(["settings"]);
    expect(report.skipped).toEqual([
      {
        pluginId: "header",
        reason: "dependency-failed",
        detail: 'depends on "settings", which did not load (it failed: boom)',
      },
    ]);
    // An optional dependency failing does not take the dependent down.
    expect(report.activated).toEqual(["core", "icons", "graph"]);
    expect(imported).not.toContain("plugin:header");
  });

  it("names the root cause down a chain of skips", async () => {
    const { report } = await load(
      [plugin("a"), plugin("b", { dependencies: { a: "^1.0" } }), plugin("c", { dependencies: { b: "^1.0" } })],
      { a: () => Promise.reject(new Error("nope")), b: () => undefined, c: () => undefined },
    );
    expect(report.skipped.map((s) => s.pluginId)).toEqual(["b", "c"]);
    expect(report.skipped[1]?.detail).toContain('"b", which did not load (depends on "a"');
  });

  it("withdraws the registry items it added before throwing, and keeps other plugins' items", async () => {
    const items = createRegistry<{ id: string }>({ key: (i) => i.id });
    const { report } = await load([plugin("host"), plugin("good"), plugin("bad")], {
      host: () => undefined,
      good: () => void items.add({ id: "good.item" }),
      bad: () => {
        items.add({ id: "bad.item" });
        throw new Error("after adding");
      },
    });
    expect(report.failed.map((f) => f.pluginId)).toEqual(["bad"]);
    expect(items.entries()).toEqual([{ value: { id: "good.item" }, pluginId: "good" }]);
    withdrawFromRegistries("good");
  });

  it("attributes items added at module scope (during the import) to the importing plugin", async () => {
    const items = createRegistry<{ id: string }>({ key: (i) => i.id });
    const recorded = fakeHost();
    await loadPlugins({
      host: recorded.host,
      plugins: [plugin("contrib")],
      kernelVersion: KERNEL_API_VERSION,
      order: ["contrib"],
      importModule: async () => {
        items.add({ id: "x" });
        return { default: () => undefined };
      },
    });
    expect(items.entries()).toEqual([{ value: { id: "x" }, pluginId: "contrib" }]);
    withdrawFromRegistries("contrib");
  });

  it("treats a module with no default export as a failure, not a silent skip", async () => {
    const { report } = await load([plugin("a")], { a: { notActivate: 1 } });
    expect(report.failed[0]?.error.message).toMatch(/no default-exported activate/);
  });

  it("treats a module that will not load as a failure of that plugin alone", async () => {
    const { report } = await load([plugin("a"), plugin("b")], { b: () => undefined });
    expect(report.failed.map((f) => f.pluginId)).toEqual(["a"]);
    expect(report.activated).toEqual(["b"]);
  });

  it("does not let a non-Error throw escape as something else", async () => {
    const { report } = await load([plugin("a")], {
      a: () => {
        throw "a string";
      },
    });
    expect(report.failed[0]?.error).toBeInstanceOf(Error);
    expect(report.failed[0]?.error.message).toBe("a string");
  });
});

describe("the loader re-checks the manifest itself", () => {
  it("skips a malformed manifest before importing anything, and its dependents", async () => {
    const broken = { ...plugin("bad"), manifest: { ...plugin("bad").manifest, version: "one" } };
    const { report, imported } = await load([broken, plugin("user", { dependencies: { bad: "^1.0" } })], {
      bad: () => undefined,
      user: () => undefined,
    });
    expect(imported).toEqual([]);
    expect(report.skipped.map((s) => [s.pluginId, s.reason])).toEqual([
      ["bad", "invalid-manifest"],
      ["user", "dependency-failed"],
    ]);
  });

  it("skips a plugin that needs a different kernel than this bundle", async () => {
    const { report } = await load([plugin("old", { kernel: "^2.0" })], { old: () => undefined });
    expect(report.skipped).toEqual([expect.objectContaining({ pluginId: "old", reason: "kernel-mismatch" })]);
  });
});

describe("kernel.plugins.optional", () => {
  it("imports an active optional dependency by specifier, and answers undefined for an absent one", async () => {
    const imports: string[] = [];
    const plugins = new PluginsHost(async (specifier) => {
      imports.push(specifier);
      return { hello: "icons" };
    });
    const icons = plugin("icons").manifest;
    const graph = plugin("graph", { optionalDependencies: { icons: "^1.0", search: "^1.0" } }).manifest;
    plugins.configure([icons, graph]);
    plugins.markActive(icons);
    const api = plugins.forPlugin(graph);
    await expect(api.optional<{ hello: string }>("icons")).resolves.toEqual({ hello: "icons" });
    await expect(api.optional("search")).resolves.toBeUndefined();
    await expect(api.optional("router")).rejects.toThrow(/not listed under optionalDependencies/);
    expect(imports).toEqual(["plugin:icons"]);
  });
});

describe("package URLs", () => {
  it("resolves a root-relative baseUrl against the document", () => {
    const entry = plugin("themes", { version: "2.1.0", style: "style.css" });
    expect(moduleUrl(entry)).toBe("http://localhost/plugins/themes/2.1.0/frontend/index.mjs");
    expect(styleUrl(entry)).toBe("http://localhost/plugins/themes/2.1.0/style.css");
    expect(styleUrl(plugin("themes"))).toBeUndefined();
  });

  it("appends the server's content fingerprint so a rebuild at the same version busts every cache", () => {
    const entry = plugin("themes", { version: "2.1.0", style: "style.css", assetsVersion: "abc123def456" });
    expect(moduleUrl(entry)).toBe("http://localhost/plugins/themes/2.1.0/frontend/index.mjs?v=abc123def456");
    expect(styleUrl(entry)).toBe("http://localhost/plugins/themes/2.1.0/style.css?v=abc123def456");
  });
});

describe("the aggregated notice (SPEC §6.4)", () => {
  it("is one notice listing everything, with a link to admin", () => {
    const notice = failureNotice(
      {
        activated: ["a"],
        failed: [{ pluginId: "b", error: new Error("boom") }],
        skipped: [
          { pluginId: "c", reason: "dependency-failed", detail: 'depends on "b", which did not load' },
          { pluginId: "d", reason: "disabled", detail: "safe mode" },
        ],
        elapsedMs: 3,
      },
      () => undefined,
    );
    expect(notice?.id).toBe("kernel:plugins-failed");
    expect(notice?.level).toBe("warning");
    expect(notice?.message).toContain("1 plugin failed");
    expect(notice?.detail).toContain("b: boom");
    expect(notice?.detail).toContain("c: ");
    // A deliberately disabled plugin is not a problem to report, nor counted.
    expect(notice?.detail).not.toContain("d: ");
    expect(notice?.message).toContain("1 skipped");
    expect(notice?.actions?.[0]?.label).toBe("Open admin");
  });

  it("is absent when the only skip was a deliberate one", () => {
    const quiet = failureNotice({
      activated: ["shell-ui"],
      failed: [],
      skipped: [{ pluginId: "third-party", reason: "disabled", detail: "safe mode" }],
      elapsedMs: 1,
    });
    expect(quiet).toBeUndefined();
  });

  it("is absent when nothing went wrong", () => {
    expect(failureNotice({ activated: ["a"], failed: [], skipped: [], elapsedMs: 1 })).toBeUndefined();
  });

  it("names the count when only skips happened", () => {
    const notice = failureNotice({
      activated: [],
      failed: [],
      skipped: [{ pluginId: "x", reason: "kernel-mismatch", detail: "needs kernel ^99" }],
      elapsedMs: 1,
    });
    expect(notice?.message).toContain("1 plugin");
    expect(notice?.actions).toBeUndefined();
  });
});

describe("stylesheets", () => {
  it("does nothing without a document, rather than throwing", async () => {
    const spy = vi.spyOn(console, "warn");
    const { report } = await load([plugin("themes", { style: "style.css" })], { themes: () => ({}) });
    expect(report.activated).toEqual(["themes"]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
