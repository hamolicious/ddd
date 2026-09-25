/**
 * The plugin loader: fetch, activate, and contain the damage.
 *
 * The contract it implements (SPEC §6.4), in the order the failures matter:
 *
 * 1. **One aggregated notice.** A workspace with three broken plugins shows one
 *    notice listing them and linking to admin, never three modals.
 * 2. **A failed `activate()` skips all transitive dependents** and withdraws
 *    everything the failed plugin had already registered — a plugin that defined a
 *    point and then threw must not leave a half-claimed registry behind.
 * 3. **Every contributed component is wrapped in an error boundary.** That happens
 *    in `kernel.ui.boundary`, which the consumers of a point call; the loader's part
 *    is passing the report channel through so a render failure lands in the same
 *    notice as an activation failure.
 * 4. **`style.css` is linked on activation** (SPEC §6.4), not bundled into the
 *    module, so a plugin's CSS is visible in devtools as a file with its name on it.
 *
 * Activation is **reload-only**: plugins load once, here, in topological order.
 * There is no hot path, and installing or enabling one prompts a reload.
 */

import {
  validateManifest,
  type InstalledPlugin,
  type Kernel,
  type PluginModule,
} from "@kernel";
import type { KernelHost } from "@kernel/runtime/index.js";

import { resolveOrder, transitiveDependents, type SkippedPlugin } from "./order.js";

export interface LoadOptions {
  readonly host: KernelHost;
  readonly plugins: readonly InstalledPlugin[];
  readonly kernelVersion: string;
  /** `?safe=1` — base distribution only. */
  readonly baseOnly?: boolean;
  /** Injectable for tests; production uses a bare dynamic `import()`. */
  readonly importModule?: (url: string) => Promise<unknown>;
  /** Called after each plugin, for a boot progress line. */
  readonly onProgress?: (progress: LoadProgress) => void;
}

export interface LoadProgress {
  readonly pluginId: string;
  readonly index: number;
  readonly total: number;
  readonly outcome: "activated" | "failed";
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
  return new URL(`${base}${relative}`, href).href;
}

/** A plugin module URL, version-scoped so it can be cached forever (SPEC §8). */
export function moduleUrl(plugin: InstalledPlugin): string {
  return packageUrl(plugin, plugin.manifest.frontend?.module ?? "");
}

export function styleUrl(plugin: InstalledPlugin): string | undefined {
  const style = plugin.manifest.frontend?.style;
  return style ? packageUrl(plugin, style) : undefined;
}

export async function loadPlugins(options: LoadOptions): Promise<LoadReport> {
  const started = Date.now();
  const importModule = options.importModule ?? ((url: string) => import(/* @vite-ignore */ url));

  // A manifest the server served but this client cannot make sense of is skipped
  // here rather than trusted: the loader's independent re-validation (SPEC §6.4).
  const wellFormed: InstalledPlugin[] = [];
  const skipped: SkippedPlugin[] = [];
  for (const plugin of options.plugins) {
    const problems = validateManifest(plugin.manifest);
    if (problems.length === 0) {
      wellFormed.push(plugin);
      continue;
    }
    // `invalid-manifest`, not `disabled`: nobody chose this. `disabled` is the one
    // reason the aggregated notice suppresses (safe mode skipping third-party plugins
    // is not a problem to report), and filing a rejected manifest under it made a
    // plugin vanish with no user-visible trace at all.
    skipped.push({
      pluginId:
        typeof (plugin.manifest as { id?: unknown }).id === "string" ? plugin.manifest.id : "<unnamed>",
      reason: "invalid-manifest",
      detail: `malformed manifest: ${problems.map((p) => `${p.field} ${p.message}`).join("; ")}`,
    });
  }

  const resolved = resolveOrder(wellFormed, {
    kernelVersion: options.kernelVersion,
    ...(options.baseOnly !== undefined ? { baseOnly: options.baseOnly } : {}),
  });
  skipped.push(...resolved.skipped);

  const activated: string[] = [];
  const failed: FailedPlugin[] = [];
  const dead = new Set<string>();

  for (const [index, plugin] of resolved.order.entries()) {
    const id = plugin.manifest.id;
    if (dead.has(id)) continue;

    let kernel: Kernel | undefined;
    try {
      linkStylesheet(plugin);
      const module = (await importModule(moduleUrl(plugin))) as Partial<PluginModule>;
      if (typeof module.default !== "function") {
        throw new Error("the frontend module has no default-exported activate(kernel) function");
      }
      kernel = options.host.forPlugin(plugin.manifest);
      const api = await module.default(kernel);
      options.host.services.publish(id, api);
      activated.push(id);
      options.onProgress?.({ pluginId: id, index, total: resolved.order.length, outcome: "activated" });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // Withdraw whatever it managed to register before throwing: a point it
      // defined, a contribution it made, a mount it took.
      options.host.retract(id);
      failed.push({ pluginId: id, error });
      options.onProgress?.({ pluginId: id, index, total: resolved.order.length, outcome: "failed" });

      for (const dependent of transitiveDependents(id, resolved.order)) {
        if (dead.has(dependent)) continue;
        dead.add(dependent);
        skipped.push({
          pluginId: dependent,
          reason: "dependency-skipped",
          detail: `"${id}" failed to activate`,
        });
      }
    }
  }

  return { activated, failed, skipped, elapsedMs: Date.now() - started };
}

/**
 * One `<link>` per plugin stylesheet, tagged with the plugin id. Idempotent, so a
 * reload-in-place during development does not stack them.
 */
function linkStylesheet(plugin: InstalledPlugin): void {
  const href = styleUrl(plugin);
  if (!href || typeof document === "undefined") return;
  const existing = document.querySelector(`link[data-lm-plugin="${plugin.manifest.id}"]`);
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
 * boot. Counting them while listing only the rest was worse — "3 plugins were skipped"
 * above a list of one — so the message and the detail are built from the same set.
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
