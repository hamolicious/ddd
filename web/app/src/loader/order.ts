/**
 * Dependency resolution for the plugin set: what loads, in what order, and what is
 * skipped before a single module is fetched.
 *
 * Four things are decided here, all of them from SPEC §6.1/§6.4:
 *
 * - **Topological order.** "Plugins depend on plugins (semver); both sides load in
 *   topological order." Ties are broken by id so the order is deterministic across
 *   reloads — a plugin whose position moves between boots is an ordering bug that
 *   only shows up in production.
 * - **The loader re-checks the kernel range itself.** The server enforces it at
 *   install, but a stale offline client can be running an older bundle than the
 *   plugin was installed against, and activating it anyway fails in pieces instead
 *   of once, with no explanation (SPEC §6.4).
 * - **A missing or unsatisfiable dependency skips the dependent**, transitively.
 * - **A cycle skips every plugin in it.** There is no "load it anyway and hope":
 *   `services.require` would see a half-built dependency.
 *
 * Pure functions over data — no fetching, no DOM — because this is the part worth
 * unit-testing, and `order.test.ts` does.
 */

import { satisfies, type InstalledPlugin } from "@kernel";

export type SkipReason =
  /**
   * Deliberately not loaded: safe mode, or a plugin an admin disabled. The only
   * reason that is **not** a problem, and the only one the aggregated notice stays
   * quiet about (`failureNotice`).
   */
  | "disabled"
  /** The loader's own manifest re-check refused it (SPEC §6.4, stale offline clients). */
  | "invalid-manifest"
  | "no-frontend"
  | "kernel-mismatch"
  | "missing-dependency"
  | "dependency-version"
  | "dependency-skipped"
  | "cycle";

export interface SkippedPlugin {
  readonly pluginId: string;
  readonly reason: SkipReason;
  /** One sentence, shown in the aggregated notice and the admin view. */
  readonly detail: string;
}

export interface OrderResult {
  /** Activation order. Every entry has a frontend module and satisfiable deps. */
  readonly order: readonly InstalledPlugin[];
  readonly skipped: readonly SkippedPlugin[];
}

export interface OrderOptions {
  /** The `@kernel` contract version this bundle implements. */
  readonly kernelVersion: string;
  /** `?safe=1`: only the base distribution (SPEC §6.1). */
  readonly baseOnly?: boolean;
}

export function resolveOrder(
  plugins: readonly InstalledPlugin[],
  options: OrderOptions,
): OrderResult {
  const skipped: SkippedPlugin[] = [];
  const skip = (pluginId: string, reason: SkipReason, detail: string): void => {
    skipped.push({ pluginId, reason, detail });
  };

  // Pass 1: the plugin's own admissibility. Nothing here depends on other plugins.
  const candidates = new Map<string, InstalledPlugin>();
  for (const plugin of [...plugins].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
    const { manifest } = plugin;
    if (options.baseOnly && !plugin.base) {
      skip(manifest.id, "disabled", "safe mode: base plugins only");
      continue;
    }
    if (plugin.state !== "enabled") {
      skip(manifest.id, "disabled", `plugin state is "${plugin.state}"`);
      continue;
    }
    if (!manifest.frontend?.module) {
      // Backend-only plugins are normal (SPEC §6.3), not a problem to report.
      continue;
    }
    if (!satisfies(options.kernelVersion, manifest.kernel)) {
      skip(
        manifest.id,
        "kernel-mismatch",
        `needs kernel ${manifest.kernel}, this client implements ${options.kernelVersion}`,
      );
      continue;
    }
    candidates.set(manifest.id, plugin);
  }

  // Pass 2: dependencies. Iterated to a fixed point, because dropping one plugin
  // can invalidate another that depended on it.
  for (;;) {
    let dropped = false;
    for (const [id, plugin] of [...candidates]) {
      for (const [dependency, range] of Object.entries(plugin.manifest.dependencies ?? {})) {
        const resolved = candidates.get(dependency);
        if (!resolved) {
          const present = plugins.find((p) => p.manifest.id === dependency);
          candidates.delete(id);
          dropped = true;
          skip(
            id,
            present ? "dependency-skipped" : "missing-dependency",
            present
              ? `dependency "${dependency}" is not being loaded`
              : `dependency "${dependency}" is not installed`,
          );
          break;
        }
        if (!satisfies(resolved.manifest.version, range)) {
          candidates.delete(id);
          dropped = true;
          skip(
            id,
            "dependency-version",
            `needs "${dependency}" ${range}, installed version is ${resolved.manifest.version}`,
          );
          break;
        }
      }
    }
    if (!dropped) break;
  }

  // Pass 3: topological order over what survived. Kahn's algorithm, with the ready
  // set kept sorted so the result is stable.
  const order: InstalledPlugin[] = [];
  const remaining = new Map(candidates);
  for (;;) {
    const ready = [...remaining.values()]
      .filter((plugin) =>
        Object.keys(plugin.manifest.dependencies ?? {}).every((dep) => !remaining.has(dep)),
      )
      .sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    if (ready.length === 0) break;
    for (const plugin of ready) {
      remaining.delete(plugin.manifest.id);
      order.push(plugin);
    }
  }
  // Whatever is left is in (or downstream of) a cycle.
  for (const plugin of [...remaining.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id))) {
    skip(
      plugin.manifest.id,
      "cycle",
      `dependency cycle involving ${[...remaining.keys()].sort().join(", ")}`,
    );
  }

  return { order, skipped };
}

/**
 * Everything that depends on `failed`, transitively, within `plugins`.
 *
 * This is SPEC §6.4's "an `activate()` throw marks the plugin failed and skips all
 * transitive dependents": a dependent whose dependency never returned an API has no
 * honest way to run, and letting it try produces a second, unrelated-looking error.
 */
export function transitiveDependents(
  failed: string,
  plugins: readonly InstalledPlugin[],
): ReadonlySet<string> {
  const dependents = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const plugin of plugins) {
      const id = plugin.manifest.id;
      if (id === failed || dependents.has(id)) continue;
      const deps = Object.keys(plugin.manifest.dependencies ?? {});
      if (deps.some((dep) => dep === failed || dependents.has(dep))) {
        dependents.add(id);
        grew = true;
      }
    }
  }
  return dependents;
}
