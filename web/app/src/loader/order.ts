/**
 * What loads, in what order, and what is skipped before a single module is fetched.
 *
 * The order is the **server's**: it resolves the live wiring natively (PLUGIN-PROTOCOLS §6)
 * and ships the result with the plugin list, so boot needs neither the Wasm core nor a
 * TypeScript resolver. What only this client can know is still decided here:
 *
 * - **The loader re-checks the kernel range itself.** The server enforces it at install,
 *   but a stale offline client can be running an older bundle than the plugin was
 *   installed against, and activating it anyway fails in pieces instead of once, with no
 *   explanation (SPEC §6.4).
 * - **A plugin dropped here takes down whatever requires it**, through the resolution's
 *   activation edges (a required service wire).
 *
 * Pure functions over data — no fetching, no DOM — because this is the part worth
 * unit-testing, and `order.test.ts` does.
 */

import { satisfies, type InstalledPlugin, type Resolution } from "@kernel";

export type SkipReason =
  /**
   * Deliberately not loaded: safe mode, or a plugin an admin disabled. The only
   * reason that is **not** a problem, and the only one the aggregated notice stays
   * quiet about (`failureNotice`).
   */
  | "disabled"
  /** The loader's own manifest re-check refused it (SPEC §6.4, stale offline clients). */
  | "invalid-manifest"
  | "kernel-mismatch"
  /** In, or behind, a cycle of required service wires. */
  | "cycle"
  /** A required service port has nothing to bind to (PLUGIN-PROTOCOLS §6). */
  | "missing-service"
  /** A required service's provider does not activate. */
  | "service-skipped";

export interface SkippedPlugin {
  readonly pluginId: string;
  readonly reason: SkipReason;
  /** One sentence, shown in the aggregated notice and the admin view. */
  readonly detail: string;
}

export interface OrderResult {
  /** Activation order. Every entry has a frontend module and its required services. */
  readonly order: readonly InstalledPlugin[];
  readonly skipped: readonly SkippedPlugin[];
}

export interface OrderOptions {
  /** The `@kernel` contract version this bundle implements. */
  readonly kernelVersion: string;
}

/**
 * The activation order the **server** resolved (PLUGIN-PROTOCOLS §6), with this client's
 * own floor on top.
 *
 * The server knows the wiring, the protocols and every plugin's state, and resolves them
 * natively, so boot needs neither the Wasm core nor a TypeScript resolver. What only this
 * client can know is still checked here: a manifest it cannot read, and a kernel range its
 * own bundle does not implement (a stale offline client, SPEC §6.4). A plugin dropped for
 * either reason takes down whatever requires it, through the resolution's activation edges.
 */
export function orderFromResolution(
  plugins: readonly InstalledPlugin[],
  resolution: Resolution,
  options: OrderOptions,
): OrderResult {
  const byId = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin]));
  const skipped: SkippedPlugin[] = resolution.skipped.map((skip) => ({
    pluginId: skip.plugin,
    reason: skip.reason,
    detail: skip.detail,
  }));
  const dead = new Set<string>();
  const order: InstalledPlugin[] = [];
  for (const id of resolution.order) {
    const plugin = byId.get(id);
    if (!plugin) {
      // Served in the resolution but not in the list this client validated: its manifest
      // was refused on the way in, and that skip is already reported.
      dead.add(id);
      continue;
    }
    if (!satisfies(options.kernelVersion, plugin.manifest.kernel)) {
      skipped.push({
        pluginId: id,
        reason: "kernel-mismatch",
        detail: `needs kernel ${plugin.manifest.kernel}, this client implements ${options.kernelVersion}`,
      });
      dead.add(id);
      continue;
    }
    order.push(plugin);
  }
  const alive: InstalledPlugin[] = [];
  const takenDown = dependentsOf(dead, resolution);
  for (const plugin of order) {
    const id = plugin.manifest.id;
    const cause = takenDown.get(id);
    if (cause === undefined) {
      alive.push(plugin);
      continue;
    }
    skipped.push({ pluginId: id, reason: "service-skipped", detail: `"${cause}" is not being loaded` });
  }
  return { order: alive, skipped };
}

/**
 * Every plugin that requires one in `dead`, transitively, through the resolution's
 * activation edges, mapped to the dead plugin that took it down.
 */
export function dependentsOf(dead: ReadonlySet<string>, resolution: Resolution): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  const gone = new Set(dead);
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of resolution.activation) {
      if (!edge.required || !gone.has(edge.provider) || gone.has(edge.consumer)) continue;
      gone.add(edge.consumer);
      out.set(edge.consumer, dead.has(edge.provider) ? edge.provider : (out.get(edge.provider) ?? edge.provider));
      grew = true;
    }
  }
  return out;
}
