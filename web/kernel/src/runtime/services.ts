/**
 * The service registry: the 1.x `kernel.services` API, kept as a shim while plugins move
 * to `kernel.ports` (PLUGIN-PROTOCOLS §5, §9 step 5). It goes in 2.0.
 *
 * A service is still readable only by a **declared** dependent, and `require` of an
 * undeclared id still throws even when the plugin is right there: without that check,
 * plugin A works by accident because plugin B happened to load first.
 *
 * What changed is where the answer comes from. A plugin that declares a consumed service
 * port bound to the plugin it asks for gets that port's handle, **limited to the port's
 * `needs`**, exactly as `kernel.ports.use()` would return it. A plugin that declares
 * nothing gets what the provider's `activate()` returned, as always, or the first service
 * a provider that has moved to ports serves.
 */

import { ContractViolationError, type PluginManifest, type ServicesApi } from "@kernel";

import type { PortsHost } from "./ports.js";

export class ServiceRegistry {
  readonly #services = new Map<string, unknown>();
  /** plugin id → its declared dependency ids. */
  readonly #declared = new Map<string, ReadonlySet<string>>();

  constructor(private readonly ports?: PortsHost) {}

  declare(pluginId: string, dependencies: readonly string[]): void {
    this.#declared.set(pluginId, new Set(dependencies));
  }

  publish(pluginId: string, api: unknown): void {
    this.#services.set(pluginId, api);
  }

  remove(pluginId: string): void {
    this.#services.delete(pluginId);
  }

  has(pluginId: string): boolean {
    return this.#services.has(pluginId);
  }

  list(): readonly string[] {
    return [...this.#services.keys()].sort();
  }

  forPlugin(pluginId: string, manifest?: PluginManifest): ServicesApi {
    const declared = () => this.#declared.get(pluginId) ?? new Set<string>();
    /** Through a declared port bound to `wanted`, when the plugin has one (§5). */
    const routed = (wanted: string) =>
      this.ports && manifest ? this.ports.legacyUse(pluginId, wanted) : { found: false as const };
    const check = (wanted: string): void => {
      if (wanted === pluginId || declared().has(wanted)) return;
      throw new ContractViolationError(
        `"${pluginId}" asked for the API of "${wanted}", which is not one of its declared dependencies`,
        { pluginId, wanted, declared: [...declared()] },
      );
    };
    const direct = (wanted: string): unknown => this.#services.get(wanted) ?? this.ports?.servedBy(wanted);
    return {
      require: <T>(wanted: string): T => {
        const port = routed(wanted);
        if (port.found) {
          if (port.api === undefined) {
            throw new ContractViolationError(`dependency "${wanted}" of "${pluginId}" is not bound`, { pluginId, wanted });
          }
          return port.api as T;
        }
        check(wanted);
        const api = direct(wanted);
        if (api === undefined && !this.#services.has(wanted)) {
          throw new ContractViolationError(`dependency "${wanted}" of "${pluginId}" did not activate`, {
            pluginId,
            wanted,
          });
        }
        return api as T;
      },
      get: <T>(wanted: string): T | undefined => {
        const port = routed(wanted);
        if (port.found) return port.api as T | undefined;
        check(wanted);
        return direct(wanted) as T | undefined;
      },
      has: (wanted: string) => {
        const port = routed(wanted);
        if (port.found) return port.api !== undefined;
        check(wanted);
        return direct(wanted) !== undefined || this.#services.has(wanted);
      },
      list: () => this.list(),
    };
  }
}
