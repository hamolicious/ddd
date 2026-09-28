/**
 * Protocols (PLUGIN-PROTOCOLS §2, §3): named, versioned contracts between plugins.
 *
 * The kernel knows no domain. It learns a protocol's kind and shape from its package, never
 * what a navbar is. A protocol ships inside the plugin that owns it
 * (`plugins/base/<owner>/protocols/<name>/`), and the server keeps it in its registry even
 * when that plugin is unplugged or replaced, so a replacement can speak it too.
 */

import type { Shape, ShapeJson } from "./shape.js";

/**
 * - `service`: one provider answers each consumer port (replaces `services.require`).
 * - `slot`: many contributors feed a host port, in seat order (replaces extension points).
 * - `event`: a typed message stream, many to many.
 */
export type ProtocolKind = "service" | "slot" | "event";

/** `protocol.json`: generated from `shape.mjs`, and what the server's registry stores. */
export interface ProtocolPackage {
  /** `<publisher>/<name>`. `lm/` is the base distribution's. */
  readonly id: string;
  /** Exact semver. Removing a member or making one required is a major. */
  readonly version: string;
  readonly kind: ProtocolKind;
  /** The plugin that ships it. */
  readonly owner: string;
  /** The generated declarations, relative to the package. */
  readonly types?: string;
  /** The contract, in the `s.*` vocabulary. For services and events, the offered value; for slots, one item. */
  readonly shape: ShapeJson;
  /** Slots: the field (or fields, joined with `|`) that must be unique on a host. The lower seat wins a duplicate. */
  readonly key?: string | readonly string[];
  /** Events: a new or restarted listener gets the last value at once. */
  readonly sticky?: boolean;
  readonly description?: string;
}

/**
 * What a protocol package's one hand-written file, `shape.mjs`, exports by default.
 * `protocol.json`, `index.d.ts` and `README.md` are generated from it
 * (`web/scripts/gen-protocols.ts`), and the check fails when they are stale.
 */
export interface ProtocolSource {
  readonly id: string;
  readonly version: string;
  readonly kind: ProtocolKind;
  /** The TypeScript name of the shape: `NavbarItem`, `WorkspaceIndex`. */
  readonly name: string;
  readonly description: string;
  readonly shape: Shape<unknown>;
  readonly key?: string | readonly string[];
  readonly sticky?: boolean;
  /** `import type` lines the declarations need. */
  readonly imports?: string;
  /** Extra TypeScript declarations the shape's `.as()` annotations refer to. */
  readonly declarations?: string;
}

/** `lm/router@1.0.0` → `{ id: "lm/router", version: "1.0.0" }`. */
export function protocolKey(pkg: Pick<ProtocolPackage, "id" | "version">): string {
  return `${pkg.id}@${pkg.version}`;
}
