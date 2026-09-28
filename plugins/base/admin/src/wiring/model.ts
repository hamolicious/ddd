/**
 * The graph's data: every installed plugin as a node, its declared ports, and the wires
 * the resolver drew between them (PLUGIN-PROTOCOLS §7). Pure: built from the plugin list
 * and a `Resolution`, never from the DOM.
 *
 * Port keys are `<plugin>:<port>` and wire keys `<from> -> <to>`, exactly as `wiring.json`
 * spells them, so a selection in the graph is a key in the overrides.
 */

import {
  WIRE_ARROW,
  satisfies,
  splitPortKey,
  splitProtocolRef,
  type InstalledPlugin,
  type LiveWiring,
  type ProtocolKind,
  type ProtocolPackage,
  type ResolvedWire,
  type Resolution,
  type ShapeJson,
  type WiringInput,
  type WiringOverrides,
  type WiringPlugin,
} from "@kernel";

export type PortDir = "in" | "out";
/** Which edge of the node a port sits on: `L` is "used by", `R` is "uses". */
export type Side = "L" | "R";

export interface Port {
  readonly key: string;
  readonly plugin: string;
  readonly name: string;
  readonly dir: PortDir;
  readonly kind: ProtocolKind;
  /** The protocol id. */
  readonly protocol: string;
  /** Provided: the exact version. Consumed: the range. */
  readonly version: string;
  readonly needs?: readonly string[];
  readonly optional?: boolean;
  readonly seats?: number;
  /** The default-seat hint of a provided port. */
  readonly order?: number;
  readonly side: Side;
}

export interface Node {
  readonly id: string;
  readonly version: string;
  readonly base: boolean;
  readonly hot: boolean;
  readonly name: string;
  readonly description: string;
  readonly ports: readonly Port[];
}

export interface Wire extends ResolvedWire {
  readonly key: string;
  readonly fromNode: string;
  readonly toNode: string;
}

export interface Graph {
  readonly nodes: readonly Node[];
  readonly byId: ReadonlyMap<string, Node>;
  readonly ports: ReadonlyMap<string, Port>;
  readonly wires: readonly Wire[];
  /** Host port → wires to it that are not benched, in seat order. */
  readonly seatCount: Readonly<Record<string, number>>;
}

export const wireKey = (from: string, to: string): string => `${from}${WIRE_ARROW}${to}`;
export const portKey = (plugin: string, port: string): string => `${plugin}:${port}`;
export const splitWireKey = (key: string): readonly [string, string] => {
  const at = key.indexOf(WIRE_ARROW);
  return [key.slice(0, at), key.slice(at + WIRE_ARROW.length)];
};
export const nodeOfPort = (key: string): string => splitPortKey(key)[0];

/** `lm/router` → `router`; anything else stays. */
export const shortProtocol = (id: string): string => id.replace(/^lm\//, "");

/** Which edge a port sits on: slots are hosted on the left, everything consumed sits right. */
export const sideOf = (dir: PortDir, kind: ProtocolKind): Side => ((kind === "slot") === (dir === "in") ? "L" : "R");

/** The `WiringInput` the resolver takes, built the way the app's own test hooks build it. */
export function wiringInput(
  plugins: readonly InstalledPlugin[],
  protocols: readonly ProtocolPackage[],
  wiring: WiringOverrides,
  baseOnly = false,
): WiringInput {
  const list: WiringPlugin[] = plugins.map((plugin) => ({
    id: plugin.manifest.id,
    version: plugin.manifest.version,
    base: plugin.base,
    enabled: plugin.state === "enabled",
    hot: plugin.manifest.hot === true,
    frontend: plugin.manifest.frontend !== undefined,
    ...(plugin.manifest.provides ? { provides: plugin.manifest.provides } : {}),
    ...(plugin.manifest.consumes ? { consumes: plugin.manifest.consumes } : {}),
  }));
  return { plugins: list, protocols, wiring: overridesOf(wiring), baseOnly };
}

/** The overrides alone, without `version`. */
export function overridesOf(wiring: WiringOverrides | LiveWiring): WiringOverrides {
  return { unplugged: wiring.unplugged, bind: wiring.bind, cut: wiring.cut, add: wiring.add, order: wiring.order };
}

/** Plugin ids that declare `"hot": true`, for `planWiring`. */
export const hotPlugins = (plugins: readonly InstalledPlugin[]): readonly string[] =>
  plugins.filter((plugin) => plugin.manifest.hot === true).map((plugin) => plugin.manifest.id);

export class ProtocolIndex {
  readonly #byId = new Map<string, ProtocolPackage[]>();

  constructor(packages: readonly ProtocolPackage[]) {
    for (const pkg of packages) {
      const list = this.#byId.get(pkg.id) ?? [];
      list.push(pkg);
      this.#byId.set(pkg.id, list);
    }
    for (const list of this.#byId.values()) list.sort((a, b) => compareVersions(a.version, b.version));
  }

  ids(): readonly string[] {
    return [...this.#byId.keys()].sort();
  }

  kindOf(id: string): ProtocolKind | undefined {
    return this.#byId.get(id)?.[0]?.kind;
  }

  /** The exact version, or the lowest one in a range, or the newest known. */
  at(id: string, versionOrRange: string): ProtocolPackage | undefined {
    const list = this.#byId.get(id) ?? [];
    return list.find((pkg) => pkg.version === versionOrRange) ?? list.find((pkg) => satisfies(pkg.version, versionOrRange)) ?? list.at(-1);
  }

  /** A consumed port's requirement: the protocol's shape, sliced to `needs`. */
  needShape(port: Port): ShapeJson | undefined {
    const shape = this.at(port.protocol, port.version)?.shape;
    if (!shape || !port.needs || typeof shape !== "object" || !("object" in shape)) return shape;
    const fields = shape.object;
    return { object: Object.fromEntries(port.needs.filter((k) => k in fields).map((k) => [k, fields[k] as ShapeJson])) };
  }

  /** A provided port's offer: the protocol's shape at that version. */
  offerShape(port: Port): ShapeJson | undefined {
    return this.at(port.protocol, port.version)?.shape;
  }
}

/** The fields of an object shape, spelled for a label; `[]` for anything else. */
export function shapeFields(shape: ShapeJson | undefined): readonly { readonly key: string; readonly type: string; readonly optional: boolean }[] {
  if (!shape || typeof shape !== "object" || !("object" in shape)) return [];
  return Object.entries(shape.object).map(([key, field]) => ({
    key,
    type: formatShape(typeof field === "object" && "optional" in field ? field.optional : field),
    optional: typeof field === "object" && "optional" in field,
  }));
}

export function formatShape(shape: ShapeJson): string {
  if (typeof shape === "string") return shape;
  if ("optional" in shape) return `${formatShape(shape.optional)}?`;
  if ("literal" in shape) return shape.literal.map((v) => JSON.stringify(v)).join(" | ");
  if ("union" in shape) return shape.union.map(formatShape).join(" | ");
  if ("array" in shape) return `${formatShape(shape.array)}[]`;
  if ("record" in shape) return `Record<${formatShape(shape.record)}>`;
  return "{ … }";
}

/** Nodes and ports from the plugin list and the wires from a resolution. */
export function buildGraph(plugins: readonly InstalledPlugin[], protocols: ProtocolIndex, resolution: Resolution): Graph {
  const ports = new Map<string, Port>();
  const nodes: Node[] = [];
  for (const plugin of plugins) {
    const { manifest } = plugin;
    const own: Port[] = [];
    for (const [name, consumed] of Object.entries(manifest.consumes ?? {})) {
      const [protocol, version] = splitProtocolRef(consumed.protocol);
      const kind = protocols.kindOf(protocol) ?? "service";
      own.push({
        key: portKey(manifest.id, name),
        plugin: manifest.id,
        name,
        dir: "in",
        kind,
        protocol,
        version,
        ...(consumed.needs ? { needs: consumed.needs } : {}),
        ...(consumed.optional ? { optional: true } : {}),
        ...(consumed.seats !== undefined ? { seats: consumed.seats } : {}),
        side: sideOf("in", kind),
      });
    }
    for (const [name, provided] of Object.entries(manifest.provides ?? {})) {
      const [protocol, version] = splitProtocolRef(provided.protocol);
      const kind = protocols.kindOf(protocol) ?? "service";
      own.push({
        key: portKey(manifest.id, name),
        plugin: manifest.id,
        name,
        dir: "out",
        kind,
        protocol,
        version,
        ...(provided.order !== undefined ? { order: provided.order } : {}),
        side: sideOf("out", kind),
      });
    }
    for (const port of own) ports.set(port.key, port);
    nodes.push({
      id: manifest.id,
      version: manifest.version,
      base: plugin.base,
      hot: manifest.hot === true,
      name: manifest.name ?? manifest.id,
      description: manifest.description ?? "",
      ports: own,
    });
  }
  const wires: Wire[] = resolution.wires
    .filter((wire) => ports.has(wire.from) && ports.has(wire.to))
    .map((wire) => ({ ...wire, key: wireKey(wire.from, wire.to), fromNode: nodeOfPort(wire.from), toNode: nodeOfPort(wire.to) }));
  const seatCount: Record<string, number> = {};
  for (const wire of wires) if (wire.kind === "slot" && !wire.bench) seatCount[wire.to] = (seatCount[wire.to] ?? 0) + 1;
  return { nodes, byId: new Map(nodes.map((node) => [node.id, node])), ports, wires, seatCount };
}

/** The wires into a host, seats first in seat order, then the bench. */
export function seatedWires(graph: Graph, host: string): readonly Wire[] {
  return graph.wires
    .filter((wire) => wire.to === host)
    .sort((a, b) => Number(a.bench ?? false) - Number(b.bench ?? false) || (a.seat ?? 0) - (b.seat ?? 0));
}

/** Every distinct plugin that depends on each one: consumers of its services and events, contributors to its slots. */
export function dependantCounts(nodes: readonly Node[], wires: readonly Wire[]): Readonly<Record<string, number>> {
  const by = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set()]));
  for (const wire of wires) {
    const [dependant, dependee] = wire.kind === "slot" ? [wire.fromNode, wire.toNode] : [wire.toNode, wire.fromNode];
    if (dependant !== dependee) by.get(dependee)?.add(dependant);
  }
  return Object.fromEntries([...by].map(([id, set]) => [id, set.size]));
}

/** Which kinds of wire the chips show. */
export type KindFilter = Readonly<Record<ProtocolKind, boolean>>;

/** A wire passes the kind chips and the protocol filter. */
export const wireShown = (wire: Pick<Wire, "kind" | "protocol" | "offerProtocol">, kinds: KindFilter, protocolFilter: string): boolean =>
  kinds[wire.kind] && (!protocolFilter || wire.protocol === protocolFilter || wire.offerProtocol === protocolFilter);

/** Every node with at least one wire to or from `nodeId`, in either direction; never `nodeId` itself. */
export function neighboursOf(nodeId: string, wires: readonly Pick<Wire, "fromNode" | "toNode">[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const wire of wires) {
    if (wire.fromNode === nodeId && wire.toNode !== nodeId) out.add(wire.toNode);
    else if (wire.toNode === nodeId && wire.fromNode !== nodeId) out.add(wire.fromNode);
  }
  return out;
}

/** Focus mode: the focused node and its neighbours over the wires the filters show. */
export function focusSet(nodeId: string, wires: readonly Wire[], kinds: KindFilter, protocolFilter: string): ReadonlySet<string> {
  return new Set([nodeId, ...neighboursOf(nodeId, wires.filter((wire) => wireShown(wire, kinds, protocolFilter)))]);
}

function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split(/[-+]/)[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
