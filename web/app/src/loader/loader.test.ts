/**
 * The loader's failure rules (SPEC §6.4) — the part of M3 that decides whether one
 * broken plugin is a notice or a blank app:
 *
 * - an `activate()` throw marks the plugin **failed**, withdraws what it registered,
 *   and **skips everything that requires a service it provides**, transitively, through
 *   the resolution's activation edges (those are never even imported);
 * - the loader re-validates every manifest itself, so a stale offline client refuses
 *   a plugin its bundle cannot honour instead of failing in pieces;
 * - the outcome is **one** aggregated notice.
 *
 * The host is faked here on purpose: `loadPlugins` touches exactly three things on it
 * (`forPlugin`, `ports.configure`, `retract`), the real `KernelHost` needs a DOM and a
 * sync client, and what is under test is the loader's bookkeeping, not the kernel's.
 */

import { describe, expect, it, vi } from "vitest";

import { KERNEL_API_VERSION, type InstalledPlugin, type Kernel, type PluginManifest, type Resolution } from "@kernel";
import type { KernelHost } from "@kernel/runtime/index.js";

import { failureNotice, loadPlugins, moduleUrl, styleUrl, type LoadReport } from "./loader.js";

interface Recorded {
  readonly host: KernelHost;
  readonly forPlugin: string[];
  readonly retracted: string[];
}

/** The members of `KernelHost` the loader uses, and nothing else. */
function fakeHost(): Recorded {
  const forPlugin: string[] = [];
  const retracted: string[] = [];
  const host = {
    forPlugin: (manifest: PluginManifest) => {
      forPlugin.push(manifest.id);
      return { pluginId: manifest.id, manifest } as unknown as Kernel;
    },
    ports: { configure: () => undefined },
    retract: (id: string) => void retracted.push(id),
  } as unknown as KernelHost;
  return { host, forPlugin, retracted };
}

function plugin(
  id: string,
  options: {
    version?: string;
    kernel?: string;
    base?: boolean;
    state?: InstalledPlugin["state"];
    style?: string;
    assetsVersion?: string;
  } = {},
): InstalledPlugin {
  const manifest: PluginManifest = {
    id,
    version: options.version ?? "1.0.0",
    kernel: options.kernel ?? "^2.0",
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
    ...(options.assetsVersion ? { assetsVersion: options.assetsVersion } : {}),
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

/** Without a resolution of its own, a test activates its plugins in the order it lists them. */
const load = (
  plugins: readonly InstalledPlugin[],
  activations: Readonly<Record<string, (kernel: Kernel) => unknown>>,
  extra: { resolution?: Resolution } = {},
): Promise<{ report: LoadReport; recorded: Recorded; imported: string[] }> => {
  const recorded = fakeHost();
  const { imported, importModule } = modules(activations);
  return loadPlugins({
    host: recorded.host,
    plugins,
    kernelVersion: KERNEL_API_VERSION,
    importModule,
    resolution: extra.resolution ?? resolution(plugins.map((p) => p.manifest.id)),
  }).then((report) => ({ report, recorded, imported }));
};

/** A server resolution: an order, required edges, and skips. */
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

describe("activating from the server's resolution (PLUGIN-PROTOCOLS §6)", () => {
  it("follows the resolved order and reports the server's skips", async () => {
    const order: string[] = [];
    const record = (id: string) => () => void order.push(id);
    const { report } = await load(
      [plugin("a"), plugin("b"), plugin("c"), plugin("off")],
      { a: record("a"), b: record("b"), c: record("c") },
      {
        resolution: resolution(["c", "a", "b"], [], [
          { plugin: "off", reason: "missing-service", detail: "index needs lm/workspace-index and nothing that fits is wired" },
        ]),
      },
    );
    expect(order).toEqual(["c", "a", "b"]);
    expect(report.activated).toEqual(["c", "a", "b"]);
    expect(report.skipped).toEqual([
      { pluginId: "off", reason: "missing-service", detail: "index needs lm/workspace-index and nothing that fits is wired" },
    ]);
  });

  it("still refuses a kernel range this client does not implement, and what requires it", async () => {
    const { report, imported } = await load(
      [plugin("future", { kernel: "^9.0" }), plugin("user"), plugin("free")],
      { future: () => undefined, user: () => undefined, free: () => undefined },
      { resolution: resolution(["future", "free", "user"], [["future", "user"]]) },
    );
    expect(report.activated).toEqual(["free"]);
    expect(report.skipped.map((s) => [s.pluginId, s.reason])).toEqual([
      ["future", "kernel-mismatch"],
      ["user", "service-skipped"],
    ]);
    expect(imported.some((url) => url.includes("/future/"))).toBe(false);
  });

  it("skips what requires a plugin that throws, through the activation edges", async () => {
    const { report, imported } = await load(
      [plugin("provider"), plugin("consumer"), plugin("optional-user")],
      {
        provider: () => {
          throw new Error("boom");
        },
        consumer: () => undefined,
        "optional-user": () => undefined,
      },
      {
        resolution: {
          ...resolution(["provider", "consumer", "optional-user"], [["provider", "consumer"]]),
          activation: [
            { provider: "provider", consumer: "consumer", required: true },
            { provider: "provider", consumer: "optional-user", required: false },
          ],
        },
      },
    );
    expect(report.failed.map((f) => f.pluginId)).toEqual(["provider"]);
    expect(report.skipped.map((s) => [s.pluginId, s.reason])).toEqual([["consumer", "service-skipped"]]);
    expect(report.activated).toEqual(["optional-user"]);
    expect(imported.some((url) => url.includes("/consumer/"))).toBe(false);
  });
});

describe("the happy path", () => {
  it("activates in the resolved order, handing each plugin its own kernel", async () => {
    const order: string[] = [];
    const { report, recorded } = await load(
      [plugin("editor"), plugin("document-surface")],
      {
        "document-surface": () => void order.push("document-surface"),
        editor: (kernel) => void order.push(kernel.pluginId),
      },
      { resolution: resolution(["document-surface", "editor"], [["document-surface", "editor"]]) },
    );

    expect(order).toEqual(["document-surface", "editor"]);
    expect(report.activated).toEqual(["document-surface", "editor"]);
    expect(report.failed).toEqual([]);
    expect(recorded.forPlugin).toEqual(["document-surface", "editor"]);
    expect(report.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("awaits an async activate before starting the next", async () => {
    const order: string[] = [];
    await load([plugin("slow"), plugin("next")], {
      slow: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push("slow");
      },
      next: () => void order.push("next"),
    });
    expect(order).toEqual(["slow", "next"]);
  });

  it("reports progress per plugin", async () => {
    const seen: string[] = [];
    const recorded = fakeHost();
    const { importModule } = modules({ a: () => undefined, b: () => undefined });
    await loadPlugins({
      host: recorded.host,
      plugins: [plugin("a"), plugin("b")],
      kernelVersion: KERNEL_API_VERSION,
      resolution: resolution(["a", "b"]),
      importModule,
      onProgress: (progress) => seen.push(`${progress.pluginId}:${progress.outcome}`),
    });
    expect(seen).toEqual(["a:activated", "b:activated"]);
  });
});

describe("an activate() that throws", () => {
  it("fails the plugin, retracts what it registered, and skips what requires it", async () => {
    const { report, recorded, imported } = await load(
      [plugin("markdown"), plugin("viewer"), plugin("agenda"), plugin("unrelated")],
      {
        markdown: () => {
          throw new Error("remark blew up");
        },
        viewer: () => ({}),
        agenda: () => ({}),
        unrelated: () => ({ fine: true }),
      },
      {
        resolution: resolution(
          ["markdown", "unrelated", "viewer", "agenda"],
          [
            ["markdown", "viewer"],
            ["viewer", "agenda"],
          ],
        ),
      },
    );

    expect(report.failed.map((f) => f.pluginId)).toEqual(["markdown"]);
    expect(report.failed[0]?.error.message).toBe("remark blew up");
    // Everything downstream is skipped, transitively, with the cause named.
    expect(report.skipped.map((s) => `${s.pluginId}:${s.reason}`)).toEqual([
      "viewer:service-skipped",
      "agenda:service-skipped",
    ]);
    expect(report.skipped[1]?.detail).toContain('"markdown", which provides a service it requires, failed');
    // …and never imported: a plugin whose required service has no provider cannot run.
    expect(imported).toEqual([
      "http://localhost/plugins/markdown/1.0.0/frontend/index.mjs",
      "http://localhost/plugins/unrelated/1.0.0/frontend/index.mjs",
    ]);
    expect(recorded.retracted).toEqual(["markdown"]);
    // The rest of the workspace still loads.
    expect(report.activated).toEqual(["unrelated"]);
  });

  it("treats a module with no default export as a failure, not a silent skip", async () => {
    const recorded = fakeHost();
    const report = await loadPlugins({
      host: recorded.host,
      plugins: [plugin("broken")],
      kernelVersion: KERNEL_API_VERSION,
      resolution: resolution(["broken"]),
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
      resolution: resolution(["ok", "Bad Id"]),
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

  it("skips a 1.x plugin: @kernel 2.0 removed what it was written against", async () => {
    const { report, imported } = await load([plugin("old", { kernel: "^1.0" })], { old: () => ({}) });
    expect(report.skipped[0]).toMatchObject({ pluginId: "old", reason: "kernel-mismatch" });
    expect(imported).toEqual([]);
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
    expect(moduleUrl(entry)).toBe(
      "http://localhost/plugins/themes/2.1.0/frontend/index.mjs?v=abc123def456",
    );
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
          { pluginId: "c", reason: "service-skipped", detail: '"b" failed to activate' },
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
