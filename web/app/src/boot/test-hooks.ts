/**
 * Hooks the end-to-end suite drives, installed only when `localStorage["lm:test-hooks"]`
 * is `"1"`. Nothing in the app reads them.
 *
 * `cycle(id, times)` unplugs a plugin and plugs it back in, `times` times, through the
 * same path a wiring change takes: the resolver (in the Wasm core) and the plugin runtime.
 * `resources()` counts what the kernel holds, so a test can compare before and after
 * (PLUGIN-PROTOCOLS §9 step 6: "leaves no listeners, links or mounts behind").
 */

import type { InstalledPlugin, LiveWiring, WiringInput } from "@kernel";
import type { KernelHost } from "@kernel/runtime/index.js";

import type { PluginRuntime, PluginSet } from "../loader/runtime.js";

export interface KernelResources {
  readonly held: Readonly<Record<string, number>>;
  readonly ports: ReturnType<KernelHost["ports"]["stats"]>;
  readonly links: number;
  readonly mountHolder: string | undefined;
  readonly notices: number;
  readonly active: readonly string[];
}

export function installTestHooks(host: KernelHost, runtime: PluginRuntime, baseOnly: boolean): void {
  let enabled = false;
  try {
    enabled = localStorage.getItem("lm:test-hooks") === "1";
  } catch {
    return;
  }
  if (!enabled) return;

  const input = (plugins: readonly InstalledPlugin[], wiring: LiveWiring, protocols: PluginSet["protocols"]): WiringInput => ({
    plugins: plugins.map((plugin) => ({
      id: plugin.manifest.id,
      version: plugin.manifest.version,
      base: plugin.base,
      enabled: plugin.state === "enabled",
      hot: plugin.manifest.hot === true,
      frontend: plugin.manifest.frontend !== undefined,
      ...(plugin.manifest.provides ? { provides: plugin.manifest.provides } : {}),
      ...(plugin.manifest.consumes ? { consumes: plugin.manifest.consumes } : {}),
      ...(plugin.manifest.dependencies ? { dependencies: plugin.manifest.dependencies } : {}),
    })),
    protocols,
    wiring,
    baseOnly,
  });

  const resources = (): KernelResources => {
    const held: Record<string, number> = {};
    for (const plugin of runtime.current.plugins) held[plugin.manifest.id] = host.held(plugin.manifest.id);
    return {
      held,
      ports: host.ports.stats(),
      links: document.querySelectorAll("link[data-lm-plugin]").length,
      mountHolder: host.mount.holder,
      notices: host.notices.list().length,
      active: [...runtime.active()].sort(),
    };
  };

  const cycle = async (id: string, times = 1): Promise<void> => {
    const base = runtime.current;
    for (let i = 0; i < times; i += 1) {
      const unplugged: LiveWiring = { ...base.wiring, unplugged: [...base.wiring.unplugged, id].sort() };
      const off: PluginSet = { ...base, wiring: unplugged, resolution: host.core.resolveWiring(input(base.plugins, unplugged, base.protocols)) };
      const out = await runtime.apply(off);
      if (out.kind !== "applied") throw new Error(`unplugging ${id} needed a reload: ${out.reasons.join("; ")}`);
      const back = await runtime.apply(base);
      if (back.kind !== "applied") throw new Error(`plugging ${id} back needed a reload: ${back.reasons.join("; ")}`);
      if (out.failed.length > 0 || back.failed.length > 0) {
        throw new Error(`plugins failed to start: ${[...out.failed, ...back.failed].join(", ")}`);
      }
    }
  };

  (globalThis as { __lmTest?: unknown }).__lmTest = { cycle, resources };
}
