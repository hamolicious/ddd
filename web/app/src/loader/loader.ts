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
  | "disabled"
  | "invalid-manifest"
  | "kernel-mismatch"
  | "unresolved"
  | "dependency-failed"
  | "unavailable";

export interface SkippedPlugin {
  readonly pluginId: string;
  readonly reason: SkipReason;
  readonly detail: string;
}

export interface LoadOptions {
  readonly host: KernelHost;
  readonly plugins: readonly InstalledPlugin[];
  readonly kernelVersion: string;
  readonly order: readonly string[];
  readonly serverSkipped?: readonly { readonly id: string; readonly reason: string }[];
  readonly available?: (pluginId: string) => boolean;
  readonly importModule?: (specifier: string) => Promise<unknown>;
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
  readonly elapsedMs: number;
}

export const pluginSpecifier = (id: string): string => `plugin:${id}`;

function packageUrl(plugin: InstalledPlugin, relative: string): string {
  const base = plugin.baseUrl.endsWith("/") ? plugin.baseUrl : `${plugin.baseUrl}/`;
  const href = globalThis.location?.href ?? "http://localhost/";
  const url = new URL(`${base}${relative}`, href);
  if (plugin.assetsVersion) url.searchParams.set("v", plugin.assetsVersion);
  return url.href;
}

export function moduleUrl(plugin: InstalledPlugin): string {
  return packageUrl(plugin, plugin.manifest.frontend?.module ?? "");
}

export function styleUrl(plugin: InstalledPlugin): string | undefined {
  const style = plugin.manifest.frontend?.style;
  return style ? packageUrl(plugin, style) : undefined;
}

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
      options.host.retract(id);
      options.host.plugins.markInactive(plugin.manifest);
      failed.push({ pluginId: id, error });
      for (const alias of idsOf(plugin.manifest)) down.set(alias, `it failed: ${error.message}`);
      options.onProgress?.({ pluginId: id, index, total, outcome: "failed" });
    }
  }

  return { activated, failed, skipped, elapsedMs: Date.now() - started };
}

export function linkStylesheet(plugin: InstalledPlugin): void {
  const href = styleUrl(plugin);
  if (!href || typeof document === "undefined") return;
  const existing = document.querySelector(`link[data-ddd-plugin="${plugin.manifest.id}"]`);
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset["dddPlugin"] = plugin.manifest.id;
  document.head.append(link);
}

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
    message:
      count > 0
        ? `${count} plugin${count === 1 ? "" : "s"} failed to load.${skipped > 0 ? ` ${skipped} skipped.` : ""}`
        : `${skipped} plugin${skipped === 1 ? "" : "s"} skipped.`,
    detail: problems.join("\n"),
    ...(onOpenAdmin ? { actions: [{ label: "Open admin", run: onOpenAdmin }] } : {}),
  };
}
