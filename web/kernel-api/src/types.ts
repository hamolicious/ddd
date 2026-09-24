/**
 * Shared primitives of the `@kernel` contract.
 *
 * Everything in `kernel-api/` is the **public, frozen** surface plugins compile
 * against (SPEC §6.4: "Types are the contract"). It holds declarations, a handful
 * of shipped constants (the default theme tokens), the minimal shape validators,
 * and nothing else — no DOM access, no IndexedDB, no sockets. The implementation
 * lives in `kernel/src/runtime/**` and is invisible to plugins.
 *
 * **FROZEN.** Adding an optional field to an options object is the one permitted
 * change without a kernel-major; see `web/CONTRACTS.md`.
 */

/** Undo a subscription. Idempotent by contract. */
export type Unsubscribe = () => void;

/** Undo a registration (a contribution, a token override). Idempotent. */
export interface Disposable {
  dispose(): void;
}

/** An RFC 3339 / ISO-8601 timestamp, exactly as the projection carries it. */
export type Iso8601 = string;

/**
 * A value from the shared core's value model (SPEC §3.4) — what frontmatter and
 * `%%%` sections materialize into. Mirrors `CoreValue` in `kernel/src/protocol.ts`;
 * `kernel/src/runtime/contract-parity.ts` fails the typecheck if the two drift.
 */
export type CoreValue =
  | null
  | boolean
  | number
  | string
  | readonly CoreValue[]
  | { readonly [key: string]: CoreValue };

export type CoreMap = { readonly [key: string]: CoreValue };

/** A frontmatter value a plugin may write through the splice helpers. */
export type FmValue = CoreValue;

/**
 * Per-plugin logger. Messages are prefixed with the plugin id, so a plugin's
 * noise is always attributable — plugins run unsandboxed (SPEC §6.1) and "which
 * plugin printed this" is the cheapest diagnostic there is.
 */
export interface KernelLogger {
  debug(message: string, ...detail: readonly unknown[]): void;
  info(message: string, ...detail: readonly unknown[]): void;
  warn(message: string, ...detail: readonly unknown[]): void;
  error(message: string, ...detail: readonly unknown[]): void;
}
