/**
 * The plugin runtime: the activated plugin set, and how it follows a wiring change
 * without a reload (PLUGIN-PROTOCOLS §6c).
 *
 * Boot is the loader's (`loadPlugins`). After it, every new wiring version arrives here,
 * and the runtime changes only the difference, in the plan's order:
 *
 * 1. **Stop** what goes away and what must restart, in reverse activation order: the
 *    plugin's own `deactivate()`, then the kernel withdraws everything it registered.
 * 2. **Rewire**: the ports runtime takes the new resolution, so every host's seats and
 *    every event listener update in place, with no restart.
 * 3. **Start** what arrives and what restarts, in activation order.
 *
 * A plugin restarts when a service it uses was rebound or restarted — callbacks it
 * registered on the old provider cannot move to a new one — and when its own package
 * changed (an upgrade), along with everything that uses it through services.
 *
 * **A reload only as a fallback, and only when the user says so.** A change needs one when
 * a plugin it touches does not declare `"hot": true`, when a starting plugin needs a
 * library the page's import map lacks (the map is fixed at load), when the Wasm core that
 * plans the change is missing, or when a stop throws. The runtime then reports it, and
 * the page keeps running its current version until the user reloads. Applies are queued:
 * one that arrives while another is running waits its turn.
 */

import {
  splitPortKey,
  type ApplyPlan,
  type InstalledPlugin,
  type Kernel,
  type LiveWiring,
  type PluginModule,
  type ProtocolPackage,
  type Resolution,
  type WiringOverrides,
} from "@kernel";
import type { KernelHost } from "@kernel/runtime/index.js";

import { linkStylesheet, moduleUrl, type ActiveModule } from "./loader.js";

/** What one wiring version looks like to this page. */
export interface PluginSet {
  readonly plugins: readonly InstalledPlugin[];
  readonly wiring: LiveWiring;
  readonly resolution: Resolution;
  readonly protocols: readonly ProtocolPackage[];
}

export type ApplyOutcome =
  | { readonly kind: "applied"; readonly plan: ApplyPlan; readonly failed: readonly string[] }
  | { readonly kind: "reload"; readonly reasons: readonly string[] };

export interface PluginRuntimeOptions {
  readonly host: KernelHost;
  readonly current: PluginSet;
  readonly active: Map<string, ActiveModule>;
  /** Injectable for tests; production uses a bare dynamic `import()`. */
  readonly importModule?: (url: string) => Promise<unknown>;
  /** The page's import map specifiers; a starting plugin's peer libraries must be in it. */
  readonly importMap?: () => ReadonlySet<string>;
}

export class PluginRuntime {
  #current: PluginSet;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #importModule: (url: string) => Promise<unknown>;

  constructor(private readonly options: PluginRuntimeOptions) {
    this.#current = options.current;
    this.#importModule = options.importModule ?? ((url: string) => import(/* @vite-ignore */ url));
  }

  get current(): PluginSet {
    return this.#current;
  }

  /** Activated plugin ids, in activation order. */
  active(): readonly string[] {
    return [...this.options.active.keys()];
  }

  /** Move to `next`, in place when every rule allows, queued behind any apply in flight. */
  apply(next: PluginSet): Promise<ApplyOutcome> {
    const run = this.#queue.then(() => this.#apply(next));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #apply(next: PluginSet): Promise<ApplyOutcome> {
    const { host } = this.options;
    const before = this.#current;
    const byId = new Map(next.plugins.map((plugin) => [plugin.manifest.id, plugin]));
    const was = new Map(before.plugins.map((plugin) => [plugin.manifest.id, plugin]));

    // Upgrades: a plugin whose package changed restarts.
    const upgraded = [...this.options.active.keys()].filter((id) => {
      const old = was.get(id);
      const now = byId.get(id);
      return now !== undefined && old !== undefined && (old.baseUrl !== now.baseUrl || old.assetsVersion !== now.assetsVersion);
    });
    const hot = next.plugins.filter((plugin) => plugin.manifest.hot === true).map((plugin) => plugin.manifest.id);

    let plan: ApplyPlan;
    try {
      plan = host.core.planWiring({
        before: before.resolution,
        after: next.resolution,
        beforeWiring: overrides(before.wiring),
        afterWiring: overrides(next.wiring),
        hot,
      });
    } catch (error) {
      return { kind: "reload", reasons: [`the change could not be planned here: ${message(error)}`] };
    }

    // Everything that uses an upgraded plugin through services restarts with it.
    const restart = new Set([...plan.restart, ...upgraded]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const edge of next.resolution.activation) {
        if (restart.has(edge.provider) && !restart.has(edge.consumer) && next.resolution.order.includes(edge.consumer)) {
          restart.add(edge.consumer);
          grew = true;
        }
      }
    }

    const reasons: string[] = [];
    const cold = new Set([...plan.cold, ...[...restart].filter((id) => !hot.includes(id))]);
    if (cold.size > 0) reasons.push(`not hot-pluggable: ${[...cold].sort().join(", ")}`);
    const importMap = this.options.importMap?.();
    if (importMap) {
      for (const id of [...plan.start, ...restart]) {
        const missing = Object.keys(byId.get(id)?.manifest.peerLibraries ?? {}).filter((lib) => !importMap.has(lib));
        if (missing.length > 0) reasons.push(`${id} needs ${missing.join(", ")}, which this page's import map lacks`);
      }
    }
    if (reasons.length > 0) return { kind: "reload", reasons };

    // 1. Stop, in reverse of the order they activated in.
    const activeOrder = [
      ...before.resolution.order.filter((id) => this.options.active.has(id)),
      ...[...this.options.active.keys()].filter((id) => !before.resolution.order.includes(id)),
    ];
    const stopping = activeOrder.filter((id) => plan.stop.includes(id) || restart.has(id)).reverse();
    const stopFailures: string[] = [];
    for (const id of stopping) {
      const error = await this.stop(id);
      if (error) stopFailures.push(`${id}: ${message(error)}`);
    }

    // 2. Rewire: hosts' seats and listeners update in place.
    host.ports.configure({
      protocols: next.protocols,
      manifests: next.plugins.map((plugin) => plugin.manifest),
      resolution: next.resolution,
    });
    this.#current = next;

    // 3. Start, in activation order. A failure takes down what requires it.
    const starting = next.resolution.order.filter((id) => plan.start.includes(id) || restart.has(id));
    const failed: string[] = [];
    const dead = new Set<string>();
    for (const id of starting) {
      if (dead.has(id)) continue;
      const plugin = byId.get(id);
      if (!plugin) continue;
      const error = await this.start(plugin);
      if (!error) continue;
      failed.push(id);
      for (const edge of next.resolution.activation) {
        if (edge.required && edge.provider === id) dead.add(edge.consumer);
      }
    }
    if (stopFailures.length > 0) return { kind: "reload", reasons: [`a plugin did not stop cleanly: ${stopFailures.join("; ")}`] };
    return { kind: "applied", plan: { ...plan, restart: [...restart] }, failed };
  }

  /** Deactivate one plugin and withdraw everything it registered. Returns what `deactivate` threw. */
  async stop(id: string): Promise<Error | undefined> {
    const active = this.options.active.get(id);
    this.options.active.delete(id);
    let failure: Error | undefined;
    try {
      await active?.module.deactivate?.();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    this.options.host.retract(id);
    return failure;
  }

  /** Activate one plugin the way boot does. Returns the error when it throws. */
  async start(plugin: InstalledPlugin): Promise<Error | undefined> {
    const { host } = this.options;
    const id = plugin.manifest.id;
    try {
      linkStylesheet(plugin);
      const module = (await this.#importModule(moduleUrl(plugin))) as Partial<PluginModule>;
      if (typeof module.default !== "function") {
        throw new Error("the frontend module has no default-exported activate(kernel) function");
      }
      const kernel: Kernel = host.forPlugin(plugin.manifest);
      const api = await module.default(kernel);
      host.services.publish(id, api);
      host.ports.adoptLegacyApi(id, api);
      this.options.active.set(id, { plugin, module });
      return undefined;
    } catch (error) {
      host.retract(id);
      return error instanceof Error ? error : new Error(String(error));
    }
  }
}

function overrides(wiring: LiveWiring): WiringOverrides {
  return { unplugged: wiring.unplugged, bind: wiring.bind, cut: wiring.cut, add: wiring.add, order: wiring.order };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The plugin a port key belongs to. */
export const portPlugin = (key: string): string => splitPortKey(key)[0];
