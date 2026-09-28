/**
 * The extension registry: the 1.x `kernel.extensions` API, kept as a shim over the ports
 * runtime while plugins move to `kernel.ports` (PLUGIN-PROTOCOLS §5, §9 step 5). It goes
 * in 2.0.
 *
 * The slot store is `ports.ts`'s; this file is the old vocabulary over it, with the four
 * behaviours the plugin graph was built on still true:
 *
 * 1. contributions to an undefined point **buffer** and arrive when it is defined;
 * 2. a duplicate `definePoint` **throws**;
 * 3. `get`/`subscribe` are **live**;
 * 4. shape validation **rejects loudly**, attributed to the contributing plugin;
 *
 * plus the two containment rules: a **retracted plugin releases the points it defined**
 * as well as its contributions, and **every notification is isolated**.
 *
 * What the ports store adds is the bridge. A point name is a protocol name (`navbar.item`
 * is `lm/navbar.item`), so a plugin that declares a port for the point's protocol has its
 * legacy calls routed onto that port: its `contribute` becomes an `offer` on its provided
 * port (and takes the seat the wiring gives it), its `definePoint` and `get` read its
 * consumed port's seats. A plugin that declares nothing contributes to an implicit port
 * every host of the protocol hears. Either side can move to ports first.
 */

import type {
  Contribution,
  ContributeOptions,
  Disposable,
  ExtensionPoint,
  ExtensionPointDefinition,
  ExtensionsApi,
  PluginManifest,
  SlotHost,
  Unsubscribe,
} from "@kernel";

import { PortsHost, protocolForPoint } from "./ports.js";

export interface RegistryReport {
  /** A contribution rejected by shape validation, or a duplicate key. */
  readonly pluginId: string;
  readonly point: string;
  readonly message: string;
}

export class ExtensionRegistry {
  readonly #reports: RegistryReport[] = [];
  readonly ports: PortsHost;

  /**
   * `ports` is the kernel host's own store; a registry built alone (the tests, the demo)
   * makes one.
   */
  constructor(
    private readonly onReport?: (report: RegistryReport) => void,
    ports?: PortsHost,
  ) {
    this.ports = ports ?? new PortsHost((report) => this.record(report));
  }

  /** Rejections so far — the aggregated notice and the admin view read this. */
  get reports(): readonly RegistryReport[] {
    return this.#reports;
  }

  /** Keep a report and pass it on. The kernel host routes its ports' reports through here. */
  record(report: RegistryReport): void {
    this.#reports.push(report);
    this.onReport?.(report);
  }

  definePoint<T>(owner: string, definition: ExtensionPointDefinition<T>, manifest?: PluginManifest): ExtensionPoint<T> {
    const declared = manifest ? declaredHostPort(manifest, definition.name) : undefined;
    const host: SlotHost<T> = declared
      ? this.ports.collect<T>(owner, declared)
      : this.ports.defineLegacy<T>(owner, definition);
    return {
      name: definition.name,
      get: () => host.get(),
      entries: () => host.entries().map((item) => contribution<T>(definition.name, item)),
      subscribe: (listener) => host.subscribe(listener),
    };
  }

  contribute<T>(pluginId: string, point: string, value: T, options: ContributeOptions = {}): Disposable {
    return this.ports.contributeLegacy(pluginId, point, value, options.order);
  }

  get<T>(point: string): readonly T[] {
    return this.ports.viewOf<T>(point, undefined).get();
  }

  entries<T>(point: string): readonly Contribution<T>[] {
    return this.ports
      .viewOf<T>(point, undefined)
      .entries()
      .map((item) => contribution<T>(point, item));
  }

  /** Live subscription. `subscriberId` is the plugin a throw is reported against. */
  subscribe<T>(point: string, listener: (values: readonly T[]) => void, subscriberId?: string): Unsubscribe {
    return this.ports.viewOf<T>(point, subscriberId).subscribe(listener);
  }

  isDefined(point: string): boolean {
    return this.ports.isHosted(point);
  }

  points(): readonly string[] {
    return this.ports.hostedPoints();
  }

  owner(point: string): string | undefined {
    return this.ports.legacyOwner(point);
  }

  pending(): readonly Contribution<unknown>[] {
    return this.ports.pendingLegacy();
  }

  /** Drop everything a failed or unloaded plugin registered — its contributions and its points. */
  removePlugin(pluginId: string): void {
    this.ports.removePlugin(pluginId);
  }

  /**
   * The per-plugin `ExtensionsApi` handed to `activate()`. With the plugin's manifest, its
   * legacy calls use its declared ports (§5); without, everything is implicit.
   */
  forPlugin(pluginId: string, manifest?: PluginManifest): ExtensionsApi {
    return {
      definePoint: (definition) => this.definePoint(pluginId, definition, manifest),
      contribute: (point, value, options) => this.contribute(pluginId, point, value, options),
      get: <T>(point: string) => this.ports.viewOf<T>(point, pluginId).get(),
      entries: <T>(point: string) =>
        this.ports
          .viewOf<T>(point, pluginId)
          .entries()
          .map((item) => contribution<T>(point, item)),
      subscribe: (point, listener) => this.subscribe(point, listener, pluginId),
      isDefined: (point) => this.isDefined(point),
      points: () => this.points(),
      pending: () => this.pending(),
    };
  }
}

function contribution<T>(point: string, item: { readonly pluginId: string; readonly value: T }): Contribution<T> {
  const order = (item.value as { order?: unknown } | null)?.order;
  return { point, pluginId: item.pluginId, value: item.value, order: typeof order === "number" ? order : 100 };
}

/** The consumed port a manifest declares for a point's protocol, if any. */
function declaredHostPort(manifest: PluginManifest, point: string): string | undefined {
  const protocol = protocolForPoint(point);
  for (const [name, port] of Object.entries(manifest.consumes ?? {})) {
    if (port.protocol.slice(0, port.protocol.indexOf("@")) === protocol) return name;
  }
  return undefined;
}
