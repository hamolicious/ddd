/**
 * The loader's failure rules (SPEC §6.4) — the part of M3 that decides whether one
 * broken plugin is a notice or a blank app:
 *
 * - an `activate()` throw marks the plugin **failed**, withdraws what it registered,
 *   and **skips all transitive dependents** (which are never even imported);
 * - the loader re-validates every manifest itself, so a stale offline client refuses
 *   a plugin its bundle cannot honour instead of failing in pieces;
 * - the outcome is **one** aggregated notice.
 *
 * The host is faked here on purpose: `loadPlugins` touches exactly three things on it
 * (`forPlugin`, `services.publish`, `retract`), the real `KernelHost` needs a DOM and
 * a sync client, and what is under test is the loader's bookkeeping, not the kernel's.
 */

import { describe, expect, it, vi } from "vitest";

import { KERNEL_API_VERSION, type InstalledPlugin, type Kernel, type PluginManifest } from "@kernel";
import type { KernelHost } from "@kernel/runtime/index.js";

import { failureNotice, loadPlugins, moduleUrl, styleUrl, type LoadReport } from "./loader.js";

interface Recorded {
  readonly host: KernelHost;
  readonly forPlugin: string[];
  readonly published: [string, unknown][];
  readonly retracted: string[];
}

/** The three members of `KernelHost` the loader uses, and nothing else. */
function fakeHost(): Recorded {
  const forPlugin: string[] = [];
  const published: [string, unknown][] = [];
  const retracted: string[] = [];
  const host = {
    forPlugin: (manifest: PluginManifest) => {
      forPlugin.push(manifest.id);
      return { pluginId: manifest.id, manifest } as unknown as Kernel;
    },
    services: { publish: (id: string, api: unknown) => void published.push([id, api]) },
    retract: (id: string) => void retracted.push(id),
  } as unknown as KernelHost;
  return { host, forPlugin, published, retracted };
}

function plugin(
  id: string,
  options: {
    version?: string;
    kernel?: string;
    dependencies?: Record<string, string>;
    base?: boolean;
    state?: InstalledPlugin["state"];
    style?: string;
  } = {},
): InstalledPlugin {
  const manifest: PluginManifest = {
    id,
    version: options.version ?? "1.0.0",
    kernel: options.kernel ?? "^1.0",
    ...(options.dependencies ? { dependencies: options.dependencies } : {}),
    frontend: {
      module: "frontend/index.mjs",
      ...(options.style ? { style: options.style } : {}),
    },
  };
  return {
    manifest,
    baseUrl: `/plugins/${id}/${manifest.version}/`,
    state: options.state ?? "enabled",
    base: options.base ?? true,
  };
}

/** `activate` implementations keyed by module URL. */
function modules(
  activations: Readonly<Record<string, (kernel: Kernel) => unknown>>,
): { imported: string[]; importModule: (url: string) => Promise<unknown> } {
  const imported: string[] = [];
  return {
    imported,
    importModule: (url: string) => {
      imported.push(url);
      // `/plugins/<id>/<version>/…` — the version-scoped URL of SPEC §8.
      const id = new URL(url).pathname.split("/")[2] as string;
      const activate = activations[id];
      if (!activate) return Promise.reject(new Error(`404 ${url}`));
      return Promise.resolve({ default: activate });
    },
  };
}

const load = (
  plugins: readonly InstalledPlugin[],
  activations: Readonly<Record<string, (kernel: Kernel) => unknown>>,
  extra: { baseOnly?: boolean } = {},
): Promise<{ report: LoadReport; recorded: Recorded; imported: string[] }> => {
  const recorded = fakeHost();
  const { imported, importModule } = modules(activations);
  return loadPlugins({
    host: recorded.host,
    plugins,
    kernelVersion: KERNEL_API_VERSION,
    importModule,
    ...(extra.baseOnly !== undefined ? { baseOnly: extra.baseOnly } : {}),
  }).then((report) => ({ report, recorded, imported }));
};

describe("the happy path", () => {
  it("activates in topological order and publishes each returned API", async () => {
    const order: string[] = [];
    const { report, recorded } = await load(
      [plugin("editor", { dependencies: { "document-surface": "^1.0" } }), plugin("document-surface")],
      {
        "document-surface": () => {
          order.push("document-surface");
          return { modes: true };
        },
        editor: (kernel) => {
          order.push(kernel.pluginId);
          return { editor: true };
        },
      },
    );

    expect(order).toEqual(["document-surface", "editor"]);
    expect(report.activated).toEqual(["document-surface", "editor"]);
    expect(report.failed).toEqual([]);
    expect(recorded.published).toEqual([
      ["document-surface", { modes: true }],
      ["editor", { editor: true }],
    ]);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("awaits an async activate before publishing it", async () => {
    const { recorded } = await load([plugin("slow")], {
      slow: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ready: true };
      },
    });
    expect(recorded.published).toEqual([["slow", { ready: true }]]);
  });

  it("reports progress per plugin", async () => {
    const seen: string[] = [];
    const recorded = fakeHost();
    const { importModule } = modules({ a: () => undefined, b: () => undefined });
    await loadPlugins({
      host: recorded.host,
      plugins: [plugin("a"), plugin("b")],
      kernelVersion: KERNEL_API_VERSION,
      importModule,
      onProgress: (progress) => seen.push(`${progress.pluginId}:${progress.outcome}`),
    });
    expect(seen).toEqual(["a:activated", "b:activated"]);
  });
});

describe("an activate() that throws", () => {
  it("fails the plugin, retracts what it registered, and skips its dependents", async () => {
    const { report, recorded, imported } = await load(
      [
        plugin("markdown"),
        plugin("viewer", { dependencies: { markdown: "^1.0" } }),
        plugin("agenda", { dependencies: { viewer: "^1.0" } }),
        plugin("unrelated"),
      ],
      {
        markdown: () => {
          throw new Error("remark blew up");
        },
        viewer: () => ({}),
        agenda: () => ({}),
        unrelated: () => ({ fine: true }),
      },
    );

    expect(report.failed.map((f) => f.pluginId)).toEqual(["markdown"]);
    expect(report.failed[0]?.error.message).toBe("remark blew up");
    // Everything downstream is skipped, transitively, with the cause named.
    expect(report.skipped.map((s) => `${s.pluginId}:${s.reason}`)).toEqual([
      "viewer:dependency-skipped",
      "agenda:dependency-skipped",
    ]);
    expect(report.skipped[1]?.detail).toContain('"markdown" failed');
    // …and never imported: a dependent whose dependency has no API cannot run.
    expect(imported).toEqual([
      "http://localhost/plugins/markdown/1.0.0/frontend/index.mjs",
      "http://localhost/plugins/unrelated/1.0.0/frontend/index.mjs",
    ]);
    expect(recorded.retracted).toEqual(["markdown"]);
    expect(recorded.published).toEqual([["unrelated", { fine: true }]]);
    // The rest of the workspace still loads.
    expect(report.activated).toEqual(["unrelated"]);
  });

  it("treats a module with no default export as a failure, not a silent skip", async () => {
    const recorded = fakeHost();
    const report = await loadPlugins({
      host: recorded.host,
      plugins: [plugin("broken")],
      kernelVersion: KERNEL_API_VERSION,
      importModule: () => Promise.resolve({ activate: () => undefined }),
    });
    expect(report.failed[0]?.error.message).toMatch(/default-exported activate/);
    expect(recorded.retracted).toEqual(["broken"]);
  });

  it("treats a module that will not load as a failure of that plugin alone", async () => {
    const { report } = await load([plugin("missing"), plugin("present")], {
      present: () => ({}),
    });
    expect(report.failed.map((f) => f.pluginId)).toEqual(["missing"]);
    expect(report.activated).toEqual(["present"]);
  });

  it("does not let a non-Error throw escape as something else", async () => {
    const { report } = await load([plugin("rude")], {
      rude: () => {
        throw "just a string";
      },
    });
    expect(report.failed[0]?.error).toBeInstanceOf(Error);
    expect(report.failed[0]?.error.message).toBe("just a string");
  });
});

describe("the loader re-checks the manifest itself", () => {
  it("skips a malformed manifest before importing anything", async () => {
    const recorded = fakeHost();
    const imported: string[] = [];
    const report = await loadPlugins({
      host: recorded.host,
      plugins: [
        { ...plugin("ok"), manifest: { ...plugin("ok").manifest } },
        {
          manifest: { id: "Bad Id", version: "one", kernel: "" } as unknown as PluginManifest,
          baseUrl: "/plugins/bad/1.0.0/",
          state: "enabled",
          base: false,
        },
      ],
      kernelVersion: KERNEL_API_VERSION,
      importModule: (url) => {
        imported.push(url);
        return Promise.resolve({ default: () => undefined });
      },
    });
    expect(report.activated).toEqual(["ok"]);
    // `invalid-manifest`, not `disabled`: nobody chose this, so it has to reach the
    // aggregated notice rather than being filtered out with the safe-mode skips.
    expect(report.skipped[0]).toMatchObject({ pluginId: "Bad Id", reason: "invalid-manifest" });
    expect(report.skipped[0]?.detail).toContain("malformed manifest");
    expect(imported).toHaveLength(1);

    const notice = failureNotice(report);
    expect(notice?.message).toContain("1 plugin");
    expect(notice?.detail).toContain("malformed manifest");
  });

  it("skips a plugin that needs a newer kernel than this bundle", async () => {
    const { report, imported } = await load([plugin("future", { kernel: "^99.0" })], {
      future: () => ({}),
    });
    expect(report.skipped[0]).toMatchObject({ pluginId: "future", reason: "kernel-mismatch" });
    expect(imported).toEqual([]);
  });

  it("loads base plugins only in safe mode", async () => {
    const { report, imported } = await load(
      [plugin("shell-ui", { base: true }), plugin("third-party", { base: false })],
      { "shell-ui": () => ({}), "third-party": () => ({}) },
      { baseOnly: true },
    );
    expect(report.activated).toEqual(["shell-ui"]);
    expect(report.skipped[0]).toMatchObject({ pluginId: "third-party", reason: "disabled" });
    expect(imported).toHaveLength(1);
  });
});

describe("package URLs", () => {
  it("resolves a root-relative baseUrl against the document", () => {
    const entry = plugin("themes", { version: "2.1.0", style: "style.css" });
    expect(moduleUrl(entry)).toBe("http://localhost/plugins/themes/2.1.0/frontend/index.mjs");
    expect(styleUrl(entry)).toBe("http://localhost/plugins/themes/2.1.0/style.css");
    expect(styleUrl(plugin("themes"))).toBeUndefined();
  });
});

describe("the aggregated notice (SPEC §6.4)", () => {
  it("is one notice listing everything, with a link to admin", () => {
    const notice = failureNotice(
      {
        activated: ["a"],
        failed: [{ pluginId: "b", error: new Error("boom") }],
        skipped: [
          { pluginId: "c", reason: "dependency-skipped", detail: '"b" failed to activate' },
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
    // A deliberately disabled plugin is not a problem to report.
    expect(notice?.detail).not.toContain("d: ");
    // …and it is not counted either: the message and the detail describe one set, so
    // "3 plugins were skipped" can never sit above a list of one.
    expect(notice?.message).toContain("1 skipped");
    expect(notice?.actions?.[0]?.label).toBe("Open admin");
  });

  it("is absent when the only skip was a deliberate one", () => {
    // `?safe=1` leaves every third-party plugin out by design. A notice here would cry
    // wolf on every safe boot, which is how a safe boot stops being reassuring.
    const quiet = failureNotice({
      activated: ["shell-ui"],
      failed: [],
      skipped: [{ pluginId: "third-party", reason: "disabled", detail: "safe mode" }],
      elapsedMs: 1,
    });
    expect(quiet).toBeUndefined();
  });

  it("is absent when nothing went wrong", () => {
    const clean = failureNotice({ activated: ["a"], failed: [], skipped: [], elapsedMs: 1 });
    expect(clean).toBeUndefined();
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
    // `linkStylesheet` is called for every plugin; in Node there is no document, and
    // an environment check is the difference between "no CSS" and "no app".
    const spy = vi.spyOn(console, "warn");
    const { report } = await load([plugin("themes", { style: "style.css" })], {
      themes: () => ({}),
    });
    expect(report.activated).toEqual(["themes"]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
