/**
 * The service registry: what each plugin's `activate()` returned, readable by its
 * **declared** dependents and nobody else (SPEC §6.1, §6.4).
 *
 * The declaration check is the whole point. Without it, plugin A works by accident
 * because plugin B happened to load first, and the day B is replaced or moves in
 * the topological order, A breaks with no explanation. `require` of an undeclared
 * id therefore throws even when the plugin is right there in the map.
 */

import { ContractViolationError, type ServicesApi } from "@kernel";

export class ServiceRegistry {
  readonly #services = new Map<string, unknown>();
  /** plugin id → its declared dependency ids. */
  readonly #declared = new Map<string, ReadonlySet<string>>();

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

  forPlugin(pluginId: string): ServicesApi {
    const declared = () => this.#declared.get(pluginId) ?? new Set<string>();
    const check = (wanted: string): void => {
      if (wanted === pluginId || declared().has(wanted)) return;
      throw new ContractViolationError(
        `"${pluginId}" asked for the API of "${wanted}", which is not one of its declared dependencies`,
        { pluginId, wanted, declared: [...declared()] },
      );
    };
    return {
      require: <T>(wanted: string): T => {
        check(wanted);
        if (!this.#services.has(wanted)) {
          throw new ContractViolationError(
            `dependency "${wanted}" of "${pluginId}" did not activate`,
            { pluginId, wanted },
          );
        }
        return this.#services.get(wanted) as T;
      },
      get: <T>(wanted: string): T | undefined => {
        check(wanted);
        return this.#services.get(wanted) as T | undefined;
      },
      has: (wanted: string) => {
        check(wanted);
        return this.#services.has(wanted);
      },
      list: () => this.list(),
    };
  }
}
