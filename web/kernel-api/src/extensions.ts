/**
 * `kernel.extensions` — the registry the whole microkernel turns on (SPEC §6.4).
 *
 * The kernel knows point *names* only as opaque strings: `navbar.item` means
 * nothing to it, and everything to `shell-ui`. A plugin **defines** the points it
 * owns and **contributes** to anyone's.
 *
 * The four behaviours the contract pins, because the plugin graph depends on them:
 *
 * - **Contributions to an undefined point buffer** and are delivered when (if) the
 *   point is defined. Load order is a topological order over *declared
 *   dependencies*, so a contributor may legitimately run before the owner of a
 *   point it does not depend on.
 * - **A duplicate `definePoint` throws.** Two owners of one name is an
 *   unresolvable conflict, not a merge.
 * - **`get`/`subscribe` are live.** `subscribe` fires immediately with the current
 *   values and again after every change; a panel that renders `get()` once at
 *   activation is a bug waiting for the next contributor.
 * - **Shape validation rejects loudly.** A malformed contribution throws at
 *   `contribute()` — the calling plugin's fault, reported against the calling
 *   plugin, not a silently missing menu entry three screens later.
 *
 * **FROZEN.**
 */

import type { Shape } from "./shape.js";
import type { Disposable, Unsubscribe } from "./types.js";

/** Default `order` for a contribution that does not ask for one. */
export const DEFAULT_CONTRIBUTION_ORDER = 100;

export interface ExtensionPointDefinition<T> {
  /** Dotted, lowercase, owner-prefixed: `navbar.item`, `markdown.directive`. */
  readonly name: string;
  /** Minimal runtime shape validation. Omit only for a point taking any value. */
  readonly shape?: Shape<T>;
  /** One line, shown in the admin/extension inspector. */
  readonly description?: string;
  /**
   * Identity within the point, for de-duplication and stable React keys. Two
   * contributions with the same key: **first one wins**, the second is reported
   * and dropped (the conflict rule `commands` already applies to keybindings).
   */
  readonly key?: (value: T) => string;
}

export interface Contribution<T> {
  readonly point: string;
  /** Which plugin contributed it. Always the caller — never caller-supplied. */
  readonly pluginId: string;
  readonly value: T;
  /** Ascending; ties broken by activation order. */
  readonly order: number;
}

/** The handle `definePoint` returns to the point's owner. */
export interface ExtensionPoint<T> {
  readonly name: string;
  /** Current values, ordered. */
  get(): readonly T[];
  /** Current contributions with their attribution — for error messages and admin. */
  entries(): readonly Contribution<T>[];
  /** Fires immediately, then after every change. */
  subscribe(listener: (values: readonly T[]) => void): Unsubscribe;
}

export interface ContributeOptions {
  /** Ascending sort position within the point; default {@link DEFAULT_CONTRIBUTION_ORDER}. */
  readonly order?: number;
}

export interface ExtensionsApi {
  /**
   * Claim a point. Throws `ContractViolationError` if the name is already
   * defined. The returned handle is the owner's read side; contributions that
   * arrived before this call are already in it.
   */
  definePoint<T>(definition: ExtensionPointDefinition<T>): ExtensionPoint<T>;
  /**
   * Contribute a value. Validated against the point's shape when the point is
   * defined, and at definition time when it is not (buffered contributions are
   * re-validated then, and a bad one is dropped with a reported error).
   */
  contribute<T>(point: string, value: T, options?: ContributeOptions): Disposable;
  /** Current values of a point; `[]` for an undefined one. */
  get<T>(point: string): readonly T[];
  /** Current contributions with attribution. */
  entries<T>(point: string): readonly Contribution<T>[];
  /** Live read: fires immediately, then after every change. Works on undefined points. */
  subscribe<T>(point: string, listener: (values: readonly T[]) => void): Unsubscribe;
  isDefined(point: string): boolean;
  /** Every defined point name, sorted — the extension inspector's data. */
  points(): readonly string[];
  /** Contributions still waiting for their point to be defined. */
  pending(): readonly Contribution<unknown>[];
}
