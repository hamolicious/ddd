/**
 * `kernel.ports` — how a plugin speaks protocols (PLUGIN-PROTOCOLS §5).
 *
 * A plugin names **its own ports**, never another plugin: `use("index")`, not
 * `require("indexer")`. Which plugin answers is a wiring decision made outside the plugin
 * (the manifest's `provides`/`consumes`, resolved by the server and edited in the wiring
 * editor), so a port can be rewired to another provider without the plugin changing.
 *
 * - **Services.** `serve(port, api)` provides one; `use(port)` returns what the wiring bound
 *   to a consumed port. The handle is limited to the port's `needs`: reading any other key
 *   throws `ContractViolationError`, in development and production alike.
 * - **Slots.** `offer(port, items)` offers items to every host wired to the port;
 *   `collect(port)` is a host's live list, **in seat order**. A plugin that offers several
 *   items on one port keeps them together, in the order it offered them.
 * - **Events.** `emit(port, payload)` reaches every listener wired to the port;
 *   `on(port, listener)` hears every emitter wired to it. A sticky protocol hands a new
 *   listener the last value at once.
 *
 * Every value is checked against the protocol's shape: an offer that does not match throws
 * at the provider, which is where the mistake is cheap to find. An undeclared port throws.
 *
 * **FROZEN.** New in 1.2.0; since 2.0.0 the only way plugins reach each other.
 */

import type { Disposable, Unsubscribe } from "./types.js";

/** One item on a host, with the plugin and port it came from. */
export interface SlotItem<T> {
  readonly pluginId: string;
  /** The provider's port name. */
  readonly port: string;
  readonly value: T;
}

/** A host's view of a slot port: live, in seat order. */
export interface SlotHost<T> {
  /** Current values, in seat order. */
  get(): readonly T[];
  /** Current values with attribution. */
  entries(): readonly SlotItem<T>[];
  /** Fires immediately, then after every change: an offer, a withdrawal, a rewiring. */
  subscribe(listener: (values: readonly T[]) => void): Unsubscribe;
}

export interface PortsApi {
  /**
   * The service bound to a consumed port, limited to the port's `needs`. `undefined` for an
   * optional port with nothing bound; a required port with nothing bound never gets here,
   * because the plugin does not activate.
   */
  use<T>(port: string): T;
  /** Whether a consumed service port has a provider right now. */
  bound(port: string): boolean;
  /** Provide a service on a provided port. Checked against the protocol's whole shape. */
  serve<T>(port: string, api: T): Disposable;
  /** Contribute one item, or several, to every host wired to a provided slot port. */
  offer<T>(port: string, items: T | readonly T[]): Disposable;
  /** A consumed slot port's live list, in seat order. */
  collect<T>(port: string): SlotHost<T>;
  /** Send on a provided event port. */
  emit<P>(port: string, payload: P): void;
  /** Hear a consumed event port. `from` is the emitting plugin. */
  on<P>(port: string, listener: (payload: P, from: string) => void): Unsubscribe;
}
