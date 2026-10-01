/**
 * The plugin loader: import, activate, and contain the damage (`@kernel` 3.0).
 *
 * The contract it implements (SPEC §6.4), in the order the failures matter:
 *
 * 1. **The order is the server's.** `GET /api/plugins` carries `load.normal` and
 *    `load.safe`: the enabled plugins in dependency order, every plugin after its
 *    `dependencies` and `optionalDependencies`, with what could not load (a dependency
 *    missing, out of range, disabled or in a cycle) already left out and listed under
 *    `load.skipped`. The loader re-checks only what this client alone can know.
 * 2. **Modules are imported by specifier only**, `import("plugin:<id>")`, never by URL.
 *    Plugins import each other the same way, so there is exactly one instance of every
 *    module — a URL import next to a specifier import would be two modules with two
 *    registries (the import map points `plugin:<id>` at the version-scoped `?v=` URL).
 * 3. **A failed plugin takes its dependents with it.** An import or `activate()` that
 *    throws marks the plugin failed, withdraws what it registered (registry items,
 *    subscriptions, its mount), and every plugin that lists it under `dependencies` —
 *    transitively — is skipped, never imported.
 * 4. **One aggregated notice.** A workspace with three broken plugins shows one notice
 *    listing them and linking to admin, never three modals.
 * 5. **`style.css` is linked on activation**, not bundled into the module, so a plugin's
 *    CSS is visible in devtools as a file with its name on it.
 *
 * Registry attribution: the module import and `activate` both run inside `asPlugin(id)`,
 * so whatever a plugin adds to a host's registry — at module scope or in `activate` — is
 * attributed to it (`createRegistry` in `@kernel`).
 *
 * There is no hot apply. Any change to the plugin set reloads the page
 * (`plugins.changed`, handled by the sync client).
 */

import {
  parsePluginRef,
  satisfies,
  validateManifest,
  type InstalledPlugin,
  type Kernel,
  type PluginManifest,
  type PluginModule,
} from "@kernel";
import { asPlugin, type KernelHost } from "@kernel/runtime/index.js";

export type SkipReason =
  /**
   * Deliberately not loaded: safe mode, or a plugin an admin disabled. The only reason
   * that is **not** a problem, and the only one the aggregated notice stays quiet about.
   */
  | "disabled"
  /** The loader's own manifest re-check refused it (SPEC §6.4, stale offline clients). */
  | "invalid-manifest"
  | "kernel-mismatch"
  /** The server left it out: a dependency missing, out of range, disabled or in a cycle. */
  | "unresolved"
  /** A plugin it depends on did not load in this boot. */
  | "dependency-failed"
  /** Named by the load order but absent from the list or the page's import map (a stale offline cache). */
  | "unavailable";

export interface SkippedPlugin {
  readonly pluginId: string;
  readonly reason: SkipReason;
  /** One sentence, shown in the aggregated notice and the admin view. */
  readonly detail: string;
}

export interface LoadOptions {
  readonly host: KernelHost;
  readonly plugins: readonly InstalledPlugin[];
  readonly kernelVersion: string;
  /** The server's order for this boot mode: `load.normal`, or `load.safe` for `?safe=1`. */
  readonly order: readonly string[];
  /** The server's `load.skipped`, reported alongside this client's own skips. */
  readonly serverSkipped?: readonly { readonly id: string; readonly reason: string }[];
  /**
   * Whether the page can import `plugin:<id>`. Production checks the page's import map, so
   * a stale cached map that predates a plugin skips it with a reason instead of throwing
   * "Failed to resolve module specifier" from inside its dependents. Default: always.
   */
  readonly available?: (pluginId: string) => boolean;
  /** Injectable for tests; production is `import(specifier)`. */
  readonly importModule?: (specifier: string) => Promise<unknown>;
  /** Called after each plugin, for a boot progress line. */
  readonly onProgress?: (progress: LoadProgress) => void;
}

export interface LoadProgress {
  readonly pluginId: string;
  readonly index: number;
  readonly total: number;
  readonly outcome: "activated" | "failed" | "skipped";
}

export interface FailedPlugin {
  readonly pluginId: string;
  readonly error: Error;
}

export interface LoadReport {
  readonly activated: readonly string[];
  readonly failed: readonly FailedPlugin[];
  readonly skipped: readonly SkippedPlugin[];
  /** Milliseconds from first import to last activation — the §8 perf budget. */
  readonly elapsedMs: number;
}

/** The specifier every plugin module is imported by, in the loader and in plugins alike. */
export const pluginSpecifier = (id: string): string => `plugin:${id}`;

/**
 * Resolve a path inside a plugin package.
 *
 * `baseUrl` is a **root-relative path** (`/plugins/shell-ui/1.0.0/`), which cannot be
 * the `base` argument of `new URL(rel, base)` — that requires an absolute URL, and
 * passing a path throws `Invalid base URL`. So the two are joined as text and resolved
 * against the document once; an absolute `baseUrl` (a CDN, one day) still works because
 * the joined string is then already absolute.
 *
 * `relative` is trusted only as far as `validateManifest` has already checked it: no
 * leading `/`, no `..`.
 */
function packageUrl(plugin: InstalledPlugin, relative: string): string {
  const base = plugin.baseUrl.endsWith("/") ? plugin.baseUrl : `${plugin.baseUrl}/`;
  const href = globalThis.location?.href ?? "http://localhost/";
  const url = new URL(`${base}${relative}`, href);
  // The version-scoped URL is immutable by contract, but a rebuilt base distribution
  // re-uses its version — `?v=` (the server's content fingerprint) makes "new bytes"
  // mean "new URL" for the HTTP cache, the service worker, and the script cache alike.
  if (plugin.assetsVersion) url.searchParams.set("v", plugin.assetsVersion);
  return url.href;
}

/**
 * A plugin module URL, version-scoped so it can be cached forever (SPEC §8). Only the
 * import map uses it (the dev map, `importmap.ts`); the loader imports by specifier.
 */
export function moduleUrl(plugin: InstalledPlugin): string {
  return packageUrl(plugin, plugin.manifest.frontend?.module ?? "");
}

export function styleUrl(plugin: InstalledPlugin): string | undefined {
  const style = plugin.manifest.frontend?.style;
  return style ? packageUrl(plugin, style) : undefined;
}

/**
 * This client's own floor under the server's resolution: a manifest it can read, and a
 * `kernel` range its bundle satisfies. The server enforces both at install, but a stale
 * offline client can run an older bundle than a plugin was installed against, and
 * activating it anyway fails in pieces instead of once, with no explanation (SPEC §6.4).
 */
export function clientCheck(plugin: InstalledPlugin, kernelVersion: string): SkippedPlugin | undefined {
  const id = typeof (plugin.manifest as { id?: unknown }).id === "string" ? plugin.manifest.id : "<unnamed>";
  const problems = validateManifest(plugin.manifest);
  if (problems.length > 0) {
    return {
      pluginId: id,
      reason: "invalid-manifest",
      detail: `malformed manifest: ${problems.map((p) => `${p.field} ${p.message}`).join("; ")}`,
    };
  }
  if (!satisfies(kernelVersion, plugin.manifest.kernel)) {
    return {
      pluginId: id,
      reason: "kernel-mismatch",
      detail: `needs @kernel ${plugin.manifest.kernel}; this app provides ${kernelVersion}`,
    };
  }
  return undefined;
}

/** The ids a manifest answers to: its own, and the one it stands in for (`provides`). */
function idsOf(manifest: PluginManifest): readonly string[] {
  const provided = manifest.provides ? parsePluginRef(manifest.provides) : undefined;
  return provided ? [manifest.id, provided.id] : [manifest.id];
}

export async function loadPlugins(options: LoadOptions): Promise<LoadReport> {
  const started = Date.now();
  const importModule = options.importModule ?? ((specifier: string) => import(/* @vite-ignore */ specifier));
  const byId = new Map(options.plugins.map((plugin) => [plugin.manifest.id, plugin]));

  const skipped: SkippedPlugin[] = (options.serverSkipped ?? []).map((entry) => ({
    pluginId: entry.id,
    reason: "unresolved" as const,
    detail: entry.reason,
  }));

  // Everything named by the order that this client can load at all, in order.
  const candidates: InstalledPlugin[] = [];
  for (const id of options.order) {
    const plugin = byId.get(id);
    if (!plugin) {
      skipped.push({ pluginId: id, reason: "unavailable", detail: "not in the plugin list this page has; reload while online" });
      continue;
    }
    const refused = clientCheck(plugin, options.kernelVersion);
    if (refused) {
      skipped.push(refused);
      continue;
    }
    candidates.push(plugin);
  }
  options.host.plugins.configure(candidates.map((plugin) => plugin.manifest));

  /** Why a plugin id (or an id provided through `provides`) did not load. */
  const down = new Map<string, string>();
  for (const entry of skipped) down.set(entry.pluginId, entry.detail);
  const skip = (plugin: InstalledPlugin, entry: SkippedPlugin): void => {
    skipped.push(entry);
    for (const id of idsOf(plugin.manifest)) if (!down.has(id)) down.set(id, entry.detail);
  };

  const activated: string[] = [];
  const failed: FailedPlugin[] = [];
  const total = candidates.length;

  for (const [index, plugin] of candidates.entries()) {
    const id = plugin.manifest.id;

    // The order puts every dependency first, so by now each one has activated or not.
    const missing = Object.keys(plugin.manifest.dependencies ?? {}).find((dep) => !options.host.plugins.active(dep));
    if (missing !== undefined) {
      const why = down.get(missing);
      skip(plugin, {
        pluginId: id,
        reason: "dependency-failed",
        detail: `depends on "${missing}", which did not load${why ? ` (${why})` : ""}`,
      });
      options.onProgress?.({ pluginId: id, index, total, outcome: "skipped" });
      continue;
    }

    // A backend-only plugin has nothing to import, and still counts as present.
    if (!plugin.manifest.frontend) {
      options.host.plugins.markActive(plugin.manifest);
      activated.push(id);
      options.onProgress?.({ pluginId: id, index, total, outcome: "activated" });
      continue;
    }

    if (options.available && !options.available(id)) {
      skip(plugin, {
        pluginId: id,
        reason: "unavailable",
        detail: `the page's import map has no "${pluginSpecifier(id)}"; reload while online`,
      });
      options.onProgress?.({ pluginId: id, index, total, outcome: "skipped" });
      continue;
    }

    let kernel: Kernel | undefined;
    try {
      linkStylesheet(plugin);
      // Module scope runs at import: a host's registries, a dependent's top-level `add`s.
      const module = (await asPlugin(id, () => importModule(pluginSpecifier(id)))) as Partial<PluginModule>;
      if (typeof module.default !== "function") {
        throw new Error("the frontend module has no default-exported activate(kernel) function");
      }
      const activate = module.default;
      kernel = options.host.forPlugin(plugin.manifest);
      const own = kernel;
      await asPlugin(id, () => activate(own));
      options.host.plugins.markActive(plugin.manifest);
      activated.push(id);
      options.onProgress?.({ pluginId: id, index, total, outcome: "activated" });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // Withdraw whatever it managed to register before throwing: registry items, a
      // subscription, a mount.
      options.host.retract(id);
      options.host.plugins.markInactive(plugin.manifest);
      failed.push({ pluginId: id, error });
      for (const alias of idsOf(plugin.manifest)) down.set(alias, `it failed: ${error.message}`);
      options.onProgress?.({ pluginId: id, index, total, outcome: "failed" });
    }
  }

  return { activated, failed, skipped, elapsedMs: Date.now() - started };
}

/**
 * One `<link>` per plugin stylesheet, tagged with the plugin id. Idempotent, so a
 * reload-in-place during development does not stack them.
 */
export function linkStylesheet(plugin: InstalledPlugin): void {
  const href = styleUrl(plugin);
  if (!href || typeof document === "undefined") return;
  const existing = document.querySelector(`link[data-ddd-plugin="${plugin.manifest.id}"]`);
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset["lmPlugin"] = plugin.manifest.id;
  document.head.append(link);
}

/**
 * The single aggregated notice of SPEC §6.4. Returns `undefined` when nothing went
 * wrong, so the caller does not have to decide what "empty" looks like.
 *
 * `disabled` skips are filtered out and **not counted**: `?safe=1` deliberately leaves
 * third-party plugins out, and a notice that counted those would cry wolf on every safe
 * boot. The message and the detail are built from the same set.
 */
export function failureNotice(
  report: LoadReport,
  onOpenAdmin?: () => void,
): { readonly id: string; readonly level: "warning"; readonly message: string; readonly detail: string; readonly actions?: readonly { label: string; run(): void }[] } | undefined {
  const reportable = report.skipped.filter((s) => s.reason !== "disabled");
  const problems = [
    ...report.failed.map((f) => `${f.pluginId}: ${f.error.message}`),
    ...reportable.map((s) => `${s.pluginId}: ${s.detail}`),
  ];
  if (problems.length === 0) return undefined;
  const count = report.failed.length;
  const skipped = reportable.length;
  return {
    id: "kernel:plugins-failed",
    level: "warning",
    // The second clause is dropped when there is nothing in it: the common message read
    // "1 plugin failed to load; 0 skipped." — a number whose only job was to be zero.
    message:
      count > 0
        ? `${count} plugin${count === 1 ? "" : "s"} failed to load.${skipped > 0 ? ` ${skipped} skipped.` : ""}`
        : `${skipped} plugin${skipped === 1 ? "" : "s"} skipped.`,
    detail: problems.join("\n"),
    ...(onOpenAdmin ? { actions: [{ label: "Open admin", run: onOpenAdmin }] } : {}),
  };
}
