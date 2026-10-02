import { ContractViolationError, parsePluginRef, type LoadedPlugin, type PluginManifest, type PluginsApi } from "@kernel";

export type PluginImporter = (specifier: string) => Promise<unknown>;

const defaultImporter: PluginImporter = (specifier) => import(/* @vite-ignore */ specifier);

export class PluginsHost {
  #loadSet: readonly LoadedPlugin[] = [];
  readonly #active = new Set<string>();

  constructor(private readonly importer: PluginImporter = defaultImporter) {}

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

  markActive(manifest: PluginManifest): void {
    this.#active.add(manifest.id);
    const provided = manifest.provides ? parsePluginRef(manifest.provides) : undefined;
    if (provided) this.#active.add(provided.id);
  }

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
