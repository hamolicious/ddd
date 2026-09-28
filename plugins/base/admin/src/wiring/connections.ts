/**
 * The plugin list's Connections panel, as rows (PLUGIN-PROTOCOLS §6, §6a, §6b). Pure: from
 * one plugin's ports in the graph, the resolution, the draft and the resolver's candidate
 * lists, to what each port row shows and what it offers to pick. The panel edits the same
 * draft as the Wiring tab through the same store; this file only decides the options.
 *
 * - A consumed service picks from "Automatic" (no `bind` entry), the same-protocol
 *   candidates (those that do not fit are listed disabled, with the reason), and "None" on
 *   an optional port (`bind: null`).
 * - A host lists its seats in order and its bench, and adds from same-protocol providers
 *   or, across protocols, from providers whose shape fits (a confirm first).
 * - A provided slot adds to hosts the same way; events and provided services add only
 *   within one protocol id.
 */

import type { PortCandidate, Resolution, WiringOverrides } from "@kernel";

import { nodeOfPort, seatedWires, type Graph, type Port, type PortDir, type Wire } from "./model.js";

/** The service select's value for "no `bind` entry". */
export const AUTOMATIC = "";
/** The service select's value for `bind: null`. */
export const NONE = "-";

export interface Option {
  /** A port key, or `AUTOMATIC` / `NONE`. */
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
  /** Why it is disabled, or the protocols of a by-shape pairing. */
  readonly title?: string;
  /** A different protocol whose shape fits: Connect asks first. */
  readonly byShape?: boolean;
}

export interface PillSpec {
  readonly tone: string;
  readonly text: string;
  readonly title?: string;
}

export interface Peer {
  /** The port on the other side. */
  readonly port: string;
  readonly plugin: string;
  readonly wire: string;
  readonly seat?: number;
  readonly bench: boolean;
  readonly byShape: boolean;
}

export interface ConnectionRow {
  readonly key: string;
  readonly name: string;
  readonly dir: PortDir;
  readonly kind: Port["kind"];
  /** `lm/router@^1.0` */
  readonly protocol: string;
  readonly optional: boolean;
  readonly single: boolean;
  readonly pills: readonly PillSpec[];
  /** Consumed service: the provider bound in the draft's resolution. */
  readonly bound?: string;
  /** Consumed service: the select's value and options. */
  readonly choice?: string;
  readonly choices?: readonly Option[];
  /** Consumed slot: the seats in order, then the bench. */
  readonly seats?: readonly Peer[];
  readonly bench?: readonly Peer[];
  /** Everything else: the ports wired to this one. */
  readonly peers?: readonly Peer[];
  /** The "Add…" select, when the port takes one. */
  readonly add?: readonly Option[];
}

export interface Connections {
  /** Consumed ports. */
  readonly uses: readonly ConnectionRow[];
  /** Provided ports. */
  readonly usedBy: readonly ConnectionRow[];
}

export interface ConnectionsInput {
  readonly plugin: string;
  readonly graph: Graph;
  readonly resolution: Resolution;
  readonly draft: WiringOverrides;
  /** Port key → `wiringCandidates(input, port, dir)` for each of the plugin's ports. */
  readonly candidates: Readonly<Record<string, readonly PortCandidate[]>>;
}

export function connectionRows({ plugin, graph, resolution, draft, candidates }: ConnectionsInput): Connections {
  const node = graph.byId.get(plugin);
  if (!node) return { uses: [], usedBy: [] };
  const byName = (a: Port, b: Port): number => a.name.localeCompare(b.name);
  const rows = (dir: PortDir): readonly ConnectionRow[] =>
    node.ports
      .filter((port) => port.dir === dir)
      .sort(byName)
      .map((port) => row(port, graph, resolution, draft, candidates[port.key] ?? []));
  return { uses: rows("in"), usedBy: rows("out") };
}

/** Automatic first, then what fits by hand, then what does not fit; each by port key. */
const byWeight = (a: PortCandidate, b: PortCandidate): number =>
  weight(a) - weight(b) || a.port.localeCompare(b.port);
const weight = (c: PortCandidate): number => (c.auto ? 0 : c.ok ? 1 : 2);

const reasonOf = (candidate: PortCandidate): string => candidate.reasons.slice(0, 3).join("; ") || "does not fit";

function row(port: Port, graph: Graph, resolution: Resolution, draft: WiringOverrides, candidates: readonly PortCandidate[]): ConnectionRow {
  const base = {
    key: port.key,
    name: port.name,
    dir: port.dir,
    kind: port.kind,
    protocol: port.version ? `${port.protocol}@${port.version}` : port.protocol,
    optional: port.optional === true,
    single: port.seats === 1,
    pills: pills(port, resolution, draft),
  };
  const sorted = [...candidates].sort(byWeight);
  const unplugged = (key: string): boolean => draft.unplugged.includes(nodeOfPort(key));
  // A candidate the draft cannot take: it does not fit, or its plugin is unplugged.
  const blocked = (candidate: PortCandidate): Partial<Option> =>
    !candidate.ok
      ? { disabled: true, title: reasonOf(candidate) }
      : unplugged(candidate.port)
        ? { disabled: true, title: "unplugged" }
        : !candidate.auto
          ? { title: "version outside range" }
          : {};

  if (port.dir === "in" && port.kind === "service") {
    const pinned = port.key in draft.bind;
    const pin = draft.bind[port.key];
    const choice = !pinned ? AUTOMATIC : pin === null || pin === undefined ? NONE : pin;
    const choices: Option[] = [{ value: AUTOMATIC, label: "Automatic" }];
    for (const candidate of sorted) {
      if (!candidate.same) continue;
      choices.push({ value: candidate.port, label: candidate.port, ...blocked(candidate) });
    }
    if (port.optional || choice === NONE) choices.push({ value: NONE, label: "None" });
    // A pin to something that is not a candidate any more (unplugged, uninstalled) still
    // shows as what it is, so the select never claims another value.
    if (choice !== AUTOMATIC && choice !== NONE && !choices.some((option) => option.value === choice)) {
      choices.push({ value: choice, label: `${choice} · missing`, disabled: true });
    }
    const bound = resolution.bindings[port.key];
    return { ...base, ...(bound ? { bound } : {}), choice, choices };
  }

  const wired = port.dir === "in" ? seatedWires(graph, port.key) : graph.wires.filter((wire) => wire.from === port.key);
  const peers = wired.map((wire) => peer(wire, port.dir));
  const taken = new Set(peers.map((p) => p.port));
  const add: Option[] = [];
  for (const candidate of sorted) {
    if (taken.has(candidate.port)) continue;
    if (candidate.same) {
      add.push({ value: candidate.port, label: candidate.port, ...blocked(candidate) });
    } else if (port.kind === "slot" && candidate.ok) {
      // §6b: across protocols only slots, only when the shape fits, and after a confirm.
      const other = graph.ports.get(candidate.port)?.protocol ?? "?";
      const [offer, need] = port.dir === "in" ? [other, port.protocol] : [port.protocol, other];
      add.push({
        value: candidate.port,
        label: `${candidate.port} · by shape`,
        byShape: true,
        title: `${offer} → ${need}`,
        ...(unplugged(candidate.port) ? { disabled: true, title: "unplugged" } : {}),
      });
    }
  }
  if (port.dir === "in" && port.kind === "slot") {
    return {
      ...base,
      seats: peers.filter((p) => !p.bench),
      bench: peers.filter((p) => p.bench),
      add,
    };
  }
  return { ...base, peers, add };
}

function peer(wire: Wire, dir: PortDir): Peer {
  const port = dir === "in" ? wire.from : wire.to;
  return {
    port,
    plugin: dir === "in" ? wire.fromNode : wire.toNode,
    wire: wire.key,
    ...(wire.seat !== undefined ? { seat: wire.seat } : {}),
    bench: wire.bench === true,
    byShape: wire.byShape === true,
  };
}

/** The inspector's kind and status badges, plus "automatic" for an unpinned bound service. */
function pills(port: Port, resolution: Resolution, draft: WiringOverrides): readonly PillSpec[] {
  const out: PillSpec[] = [{ tone: port.kind, text: port.kind === "slot" && port.dir === "in" ? (port.seats === 1 ? "1 seat" : "multi-seat") : port.kind }];
  const status = resolution.status[port.key];
  if (port.dir === "in" && port.kind === "service" && !(port.key in draft.bind) && resolution.bindings[port.key]) {
    out.push({ tone: "ok", text: "automatic" });
  }
  if (status) out.push({ tone: `badge-${status.code}`, text: statusText(status), title: status.code });
  if (port.optional && status?.code !== "optional") out.push({ tone: "muted", text: "optional" });
  return out;
}

/** The same words as the graph's port badge (`Graph.tsx`'s `badgeText`), without React. */
export function statusText(status: { readonly code: string; readonly count?: number }): string {
  switch (status.code) {
    case "providers":
      return `${status.count ?? 2} providers`;
    case "pin-missing":
      return "pin missing";
    case "no-fit":
      return "no fit";
    default:
      return status.code;
  }
}
