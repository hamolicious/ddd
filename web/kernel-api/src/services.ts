/**
 * `kernel.services` — the value a plugin's `activate()` returned, available to
 * its dependents (SPEC §6.4).
 *
 * This is the *only* way one plugin calls another: never a direct import, never a
 * module-level side channel (SPEC §6.1). Activation is topologically ordered and
 * reload-only, so by the time your `activate()` runs, every declared dependency
 * has already returned — which is why `require()` can be synchronous and why
 * there is no "wait for plugin X" call to misuse.
 *
 * **FROZEN.**
 */

export interface ServicesApi {
  /**
   * The API a dependency exported. Throws `ContractViolationError` when
   * `pluginId` is not a **declared** dependency of the caller — undeclared use
   * would make the load order that guarantees it exists a coincidence.
   */
  require<T>(pluginId: string): T;
  /** Like {@link require}, but `undefined` for an optional, absent dependency. */
  get<T>(pluginId: string): T | undefined;
  /** Whether a declared dependency activated successfully. */
  has(pluginId: string): boolean;
  /** Ids of every successfully activated plugin. Read-only introspection. */
  list(): readonly string[];
}
