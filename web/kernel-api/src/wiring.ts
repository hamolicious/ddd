/**
 * Plugin wiring (PLUGIN-PROTOCOLS §6): which provided port feeds which consumed port.
 *
 * `wiring.json` records only the choices a person made; everything else is automatic.
 * Keys are port keys, `<plugin>:<port>`; wires are `"<from> -> <to>"`, provider first.
 * The server stores every version and serves the live one with the plugin list.
 */

export interface WiringOverrides {
  /** Plugins switched off. Mirrors the plugin's `disabled` state both ways. */
  readonly unplugged: readonly string[];
  /** Service ports pinned to a provider port, or to `null`: deliberately unbound. */
  readonly bind: Readonly<Record<string, string | null>>;
  /** Automatic slot and event wires someone cut. */
  readonly cut: readonly string[];
  /** Wires someone added by hand. */
  readonly add: readonly string[];
  /** Host port → its seats in order, from the first edit onwards. */
  readonly order: Readonly<Record<string, readonly string[]>>;
}

/** The live wiring: a version and its overrides, as `GET /api/plugins` serves it. */
export interface LiveWiring extends WiringOverrides {
  readonly version: number;
}

/** The arrow between the two port keys of a wire. */
export const WIRE_ARROW = " -> ";

/** An empty wiring at version 0: a fresh workspace, or a server from before wiring. */
export const EMPTY_WIRING: LiveWiring = { version: 0, unplugged: [], bind: {}, cut: [], add: [], order: {} };
