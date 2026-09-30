/**
 * `kernel.plugins` — the plugin set this page booted with (`@kernel` 3.0).
 *
 * The loader tells it the load set before the first import (`configure`) and each plugin's
 * outcome as it goes (`markActive`), so a plugin activating late sees exactly which of its
 * optional dependencies made it.
 */

import { ContractViolationError, parsePluginRef, type LoadedPlugin, type PluginManifest, type PluginsApi } from "@kernel";

/** How a plugin module is imported: always by its `plugin:<id>` specifier, never by URL. */
export type PluginImporter = (specifier: string) => Promise<unknown>;

const defaultImporter: PluginImporter = (specifier) => import(/* @vite-ignore */ specifier);

export class PluginsHost {
  #loadSet: readonly LoadedPlugin[] = [];
  /** Activated ids, plus the ids they stand in for through `provides`. */
  readonly #active = new Set<string>();

  constructor(private readonly importer: PluginImporter = defaultImporter) {}

  /** The load set of this boot, in load order. */
  configure(manifests: readonly PluginManifest[]): void {
    this.#loadSet = Object.freeze(
      manifests.map((manifest) =>
        Object.freeze({
          id: manifest.id,
          version: manifest.version,
          ...(manifest.provides ? { provides: manifest.provides } : {}),
        }),
      ),
    );
  }

  /** `id` activated (it answers `active(id)`, and `active(<provided id>)` for a stand-in). */
  markActive(manifest: PluginManifest): void {
    this.#active.add(manifest.id);
    const provided = manifest.provides ? parsePluginRef(manifest.provides) : undefined;
    if (provided) this.#active.add(provided.id);
  }

  /** `id` failed or was withdrawn. */
  markInactive(manifest: PluginManifest): void {
    this.#active.delete(manifest.id);
    const provided = manifest.provides ? parsePluginRef(manifest.provides) : undefined;
    if (provided) this.#active.delete(provided.id);
  }

  active(id: string): boolean {
    return this.#active.has(id);
  }

  list(): readonly LoadedPlugin[] {
    return this.#loadSet;
  }

  /** The plugin's own view: `optional` is limited to what its manifest declares. */
  forPlugin(manifest: PluginManifest): PluginsApi {
    const declared = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.dependencies ?? {}),
    ]);
    return {
      active: (id) => this.active(id),
      list: () => this.list(),
      optional: async <M>(id: string): Promise<M | undefined> => {
        if (!declared.has(id)) {
          throw new ContractViolationError(
            `${manifest.id}: kernel.plugins.optional("${id}") — "${id}" is not listed under optionalDependencies`,
            { pluginId: manifest.id },
          );
        }
        if (!this.active(id)) return undefined;
        return (await this.importer(`plugin:${id}`)) as M;
      },
    };
  }
}
