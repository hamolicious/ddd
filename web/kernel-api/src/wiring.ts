/**
 * Plugin wiring (PLUGIN-PROTOCOLS §6): which provided port feeds which consumed port.
 *
 * `wiring.json` records only the choices a person made; everything else is automatic.
 * Keys are port keys, `<plugin>:<port>`; wires are `"<from> -> <to>"`, provider first.
 * The server stores every version and serves the live one with the plugin list.
 */

import type { ProtocolKind, ProtocolPackage } from "./protocols.js";

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

// ---------------------------------------------------------------------------
// The resolver's input and output (Rust `core::wiring`, camelCase on the wire)
// ---------------------------------------------------------------------------


/** What the resolver needs to know about one installed plugin. */
export interface WiringPlugin {
  readonly id: string;
  readonly version?: string;
  /** Part of the base distribution: kept by `?safe=1`, preferred when several providers fit. */
  readonly base?: boolean;
  /** Approved and switched on. Default `true`. */
  readonly enabled?: boolean;
  /** Declares `"hot": true`. */
  readonly hot?: boolean;
  /** Has a frontend half. Default `true`. */
  readonly frontend?: boolean;
  readonly provides?: Readonly<Record<string, { readonly protocol: string; readonly order?: number }>>;
  readonly consumes?: Readonly<
    Record<string, { readonly protocol: string; readonly needs?: readonly string[]; readonly optional?: boolean; readonly seats?: number }>
  >;
}

export interface WiringInput {
  readonly plugins: readonly WiringPlugin[];
  readonly protocols: readonly ProtocolPackage[];
  readonly wiring: WiringOverrides;
  /** `?safe=1`: only the base distribution activates. */
  readonly baseOnly?: boolean;
}

export type SkipReason =
  | "disabled"
  | "missing-service"
  | "service-skipped"
  | "cycle";

export interface ResolvedWire {
  /** The provided port, `plugin:port`. */
  readonly from: string;
  /** The consumed port. */
  readonly to: string;
  readonly kind: ProtocolKind;
  readonly protocol: string;
  readonly offerProtocol: string;
  readonly byShape?: boolean;
  /** Slots: the 1-based seat. */
  readonly seat?: number;
  readonly bench?: boolean;
  /** One end does not activate. */
  readonly inactive?: boolean;
}

export interface WiringDiagnostic {
  readonly severity: "error" | "warning";
  /** Stable: `missing-service`, `unknown-need`, `several-providers`, `pin-missing`, `no-fit`, `unheard`, … */
  readonly code: string;
  readonly plugin: string;
  readonly port?: string;
  readonly message: string;
}

export interface Resolution {
  /** Activation order of the plugins that activate. */
  readonly order: readonly string[];
  readonly skipped: readonly { readonly plugin: string; readonly reason: SkipReason; readonly detail: string }[];
  readonly wires: readonly ResolvedWire[];
  /** Service port → the provided port bound to it. */
  readonly bindings: Readonly<Record<string, string>>;
  /** Slot host port → provided ports in seat order (the bench left out). */
  readonly seats: Readonly<Record<string, readonly string[]>>;
  readonly bench: Readonly<Record<string, readonly string[]>>;
  /** Event listener port → the emitting ports it hears. */
  readonly listeners: Readonly<Record<string, readonly string[]>>;
  readonly activation: readonly { readonly provider: string; readonly consumer: string; readonly required: boolean }[];
  readonly diagnostics: readonly WiringDiagnostic[];
  /** Port → its badge: `pinned`, `providers`, `pin-missing`, `missing`, `optional`, `benched`, `unheard`, `no-fit`. */
  readonly status: Readonly<Record<string, { readonly code: string; readonly count?: number }>>;
}

export type WiringChange =
  | { readonly kind: "unplug"; readonly plugin: string }
  | { readonly kind: "plug"; readonly plugin: string }
  | { readonly kind: "bind"; readonly port: string; readonly from?: string; readonly to?: string }
  | {
      readonly kind: "seats";
      readonly port: string;
      readonly seats: readonly string[];
      readonly added: readonly string[];
      readonly removed: readonly string[];
    }
  | { readonly kind: "listen"; readonly port: string; readonly added: readonly string[]; readonly removed: readonly string[] };

/** What applying one resolution on a client running another does (§6c). */
export interface ApplyPlan {
  readonly changes: readonly WiringChange[];
  /** Reverse activation order. */
  readonly stop: readonly string[];
  /** Activation order. */
  readonly start: readonly string[];
  /** A service they use changed or restarted. Activation order. */
  readonly restart: readonly string[];
  /** Hosts and listeners that update in place. */
  readonly hosts: readonly string[];
  /** Touched plugins that are not `"hot": true`: a reload instead. */
  readonly cold: readonly string[];
  readonly alsoStops: readonly string[];
  readonly alsoStarts: readonly string[];
  readonly addedErrors: number;
}

/** One port on the other side of a port, and whether it can be wired to it. */
export interface PortCandidate {
  readonly port: string;
  /** The types fit. */
  readonly ok: boolean;
  /** Same protocol id. */
  readonly same: boolean;
  /** Same protocol, in range, fits: wired automatically. */
  readonly auto: boolean;
  readonly reasons: readonly string[];
}

/** What the server ships beside the plugin list: the live wiring resolved for this page. */
export interface ResolvedPluginSet {
  readonly normal: Resolution;
  /** `?safe=1`. */
  readonly safe: Resolution;
}

/** `lm/router@^1.0` → `["lm/router", "^1.0"]`. */
export const splitProtocolRef = (reference: string): readonly [string, string] => {
  const at = reference.indexOf("@");
  return at === -1 ? [reference, ""] : [reference.slice(0, at), reference.slice(at + 1)];
};

/** `graph:index` → `["graph", "index"]`. */
export const splitPortKey = (key: string): readonly [string, string] => {
  const colon = key.lastIndexOf(":");
  return [key.slice(0, colon), key.slice(colon + 1)];
};

