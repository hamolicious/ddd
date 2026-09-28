/**
 * The error types the kernel throws at plugins, and the one helper every stub in
 * this repository uses.
 *
 * Errors are typed because the loader has to make decisions from them: an
 * `activate()` that throws marks the plugin failed and skips its transitive
 * dependents (SPEC §6.4), and a `ContractViolationError` is the kernel saying
 * "your contribution is malformed" rather than "something went wrong".
 *
 * **FROZEN.**
 */

/** Base class, so `catch (e) { if (e instanceof KernelError) … }` works. */
export class KernelError extends Error {
  constructor(
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * A plugin's offer or call violated the contract: an item or service that does not
 * match its protocol, an undeclared port, a member read outside a port's `needs`.
 * Thrown loudly and never swallowed (SPEC §6.4: "rejects loudly").
 */
export class ContractViolationError extends KernelError {}

/** A plugin failed to activate, or a contributed component threw while rendering. */
export class PluginError extends KernelError {
  constructor(
    readonly pluginId: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`${pluginId}: ${message}`, { pluginId });
  }
}

/**
 * A capability is not available here (no shell bridge, no browser fallback, or
 * permission denied). Carries the capability name so a UI can say which one and
 * what the fallback was (SPEC §7: "Browser fallback/degradation mandatory").
 */
export class CapabilityUnavailableError extends KernelError {
  constructor(
    readonly capability: string,
    reason: string,
  ) {
    super(`capability "${capability}" is unavailable: ${reason}`, { capability });
  }
}

/** The shared Wasm core is missing or disagrees with the server's semantics version. */
export class CoreUnavailableError extends KernelError {}

/**
 * A scaffold stub. Every unimplemented body in this tree throws this, so a
 * half-built app reports *what* is missing instead of rendering blank.
 */
export class NotImplementedError extends KernelError {}

export function notImplemented(what: string): never {
  throw new NotImplementedError(`not implemented: ${what}`);
}
