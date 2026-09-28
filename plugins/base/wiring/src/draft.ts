/**
 * Draft editing (PLUGIN-PROTOCOLS §6c): every edit is a change to a `WiringOverrides`
 * value, computed here without touching the DOM or the resolver. The store resolves the
 * result and the graph draws it over the live wiring.
 *
 * Rules the functions here keep (§6, §6a, §10):
 * - connecting takes the open seat: the host's `order` list is seeded from its current
 *   seats the first time it is edited, and the new source is appended;
 * - a `seats: 1` host puts the new source first and benches the previous occupant;
 * - cut and reconnect moves a source to the bottom;
 * - a service port pins with `bind`, and cutting it binds to `null`;
 * - unplugging keeps the plugin's seats in `order`, so plugging back returns it there.
 */

import type { LiveWiring, WiringOverrides } from "@kernel";

import { nodeOfPort, splitWireKey, wireKey } from "./model.js";

export const EMPTY_OVERRIDES: WiringOverrides = { unplugged: [], bind: {}, cut: [], add: [], order: {} };

export function normalize(overrides: WiringOverrides): WiringOverrides {
  return {
    unplugged: [...new Set(overrides.unplugged)].sort(),
    bind: Object.fromEntries(Object.entries(overrides.bind).sort(([a], [b]) => a.localeCompare(b))),
    cut: [...new Set(overrides.cut)].sort(),
    add: [...new Set(overrides.add)].sort(),
    order: Object.fromEntries(
      Object.entries(overrides.order)
        .filter(([, seats]) => seats.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([host, seats]) => [host, [...seats]]),
    ),
  };
}

export const sameOverrides = (a: WiringOverrides, b: WiringOverrides): boolean =>
  JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

export const isUnplugged = (overrides: WiringOverrides, plugin: string): boolean => overrides.unplugged.includes(plugin);

export function togglePlug(overrides: WiringOverrides, plugin: string): WiringOverrides {
  const set = new Set(overrides.unplugged);
  if (set.has(plugin)) set.delete(plugin);
  else set.add(plugin);
  return { ...overrides, unplugged: [...set].sort() };
}

export interface ConnectRequest {
  readonly from: string;
  readonly to: string;
  readonly kind: "service" | "slot" | "event";
  /** Same protocol, in range, fits: the resolver would draw it on its own. */
  readonly auto: boolean;
  /** The host's current sources in seat order, the bench included last. */
  readonly current: readonly string[];
  /** A `seats: 1` host. */
  readonly single?: boolean;
  /**
   * Services: what the resolver picks for `to` with no pin at all, and whether there is a
   * choice to record. A connection to the automatic pick, with no alternative, needs no
   * `bind` entry.
   */
  readonly autoChoice?: { readonly port: string | undefined; readonly several: boolean };
}

export type ConnectOutcome =
  | { readonly ok: true; readonly overrides: WiringOverrides; readonly seat?: number; readonly benched?: string }
  | { readonly ok: false; readonly reason: string };

export function connect(overrides: WiringOverrides, request: ConnectRequest): ConnectOutcome {
  const { from, to, kind } = request;
  const key = wireKey(from, to);
  if (kind === "service") {
    const bind = { ...overrides.bind };
    const auto = request.autoChoice;
    if (auto && auto.port === from && !auto.several) delete bind[to];
    else bind[to] = from;
    return { ok: true, overrides: { ...overrides, bind } };
  }
  const at = request.current.indexOf(from);
  if (at !== -1 && !(request.single && at > 0)) {
    return { ok: false, reason: kind === "slot" ? `already in seat ${at + 1}` : "already wired" };
  }
  const cut = overrides.cut.filter((x) => x !== key);
  const add = !request.auto && !overrides.add.includes(key) ? [...overrides.add, key] : overrides.add;
  if (kind === "event") return { ok: true, overrides: { ...overrides, cut, add } };
  const rest = request.current.filter((x) => x !== from);
  const order = { ...overrides.order, [to]: request.single ? [from, ...rest] : [...rest, from] };
  return {
    ok: true,
    overrides: { ...overrides, cut, add, order },
    seat: request.single ? 1 : rest.length + 1,
    ...(request.single && rest[0] !== undefined ? { benched: rest[0] } : {}),
  };
}

export interface CutRequest {
  readonly from: string;
  readonly to: string;
  readonly kind: "service" | "slot" | "event";
}

export function cut(overrides: WiringOverrides, wire: CutRequest): WiringOverrides {
  const key = wireKey(wire.from, wire.to);
  let next: WiringOverrides = overrides;
  if (wire.kind === "service") next = { ...next, bind: { ...next.bind, [wire.to]: null } };
  else if (next.add.includes(key)) next = { ...next, add: next.add.filter((x) => x !== key) };
  else if (!next.cut.includes(key)) next = { ...next, cut: [...next.cut, key] };
  const seats = next.order[wire.to];
  if (seats) {
    const remaining = seats.filter((x) => x !== wire.from);
    const order = { ...next.order };
    if (remaining.length > 0) order[wire.to] = remaining;
    else delete order[wire.to];
    next = { ...next, order };
  }
  return next;
}

/** Swap a seat with its neighbour. `current` is the host's seats, bench excluded. */
export function moveSeat(overrides: WiringOverrides, host: string, current: readonly string[], from: string, delta: -1 | 1): WiringOverrides {
  const list = [...current];
  const i = list.indexOf(from);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= list.length) return overrides;
  const other = list[j] as string;
  list[j] = from;
  list[i] = other;
  return { ...overrides, order: { ...overrides.order, [host]: list } };
}

export function resetOrder(overrides: WiringOverrides, host: string): WiringOverrides {
  const order = { ...overrides.order };
  delete order[host];
  return { ...overrides, order };
}

/** Back to automatic wiring. Unplugged plugins stay unplugged. */
export function resetToAutomatic(overrides: WiringOverrides): WiringOverrides {
  return { ...EMPTY_OVERRIDES, unplugged: [...overrides.unplugged] };
}

// ---------------------------------------------------------------------------
// Rebasing a draft onto a newer live version
// ---------------------------------------------------------------------------

export type Edit =
  | { readonly kind: "unplug"; readonly plugin: string }
  | { readonly kind: "plug"; readonly plugin: string }
  | { readonly kind: "bind"; readonly port: string; readonly to: string | null | undefined }
  | { readonly kind: "cut"; readonly wire: string }
  | { readonly kind: "uncut"; readonly wire: string }
  | { readonly kind: "add"; readonly wire: string }
  | { readonly kind: "unadd"; readonly wire: string }
  | { readonly kind: "order"; readonly host: string; readonly seats: readonly string[] | undefined };

/** What `draft` changed relative to `base`, as a list of edits that can be replayed. */
export function edits(base: WiringOverrides, draft: WiringOverrides): readonly Edit[] {
  const out: Edit[] = [];
  for (const plugin of draft.unplugged) if (!base.unplugged.includes(plugin)) out.push({ kind: "unplug", plugin });
  for (const plugin of base.unplugged) if (!draft.unplugged.includes(plugin)) out.push({ kind: "plug", plugin });
  for (const port of new Set([...Object.keys(base.bind), ...Object.keys(draft.bind)])) {
    const before = port in base.bind ? base.bind[port] : undefined;
    const after = port in draft.bind ? draft.bind[port] : undefined;
    if (before !== after) out.push({ kind: "bind", port, to: after });
  }
  for (const wire of draft.cut) if (!base.cut.includes(wire)) out.push({ kind: "cut", wire });
  for (const wire of base.cut) if (!draft.cut.includes(wire)) out.push({ kind: "uncut", wire });
  for (const wire of draft.add) if (!base.add.includes(wire)) out.push({ kind: "add", wire });
  for (const wire of base.add) if (!draft.add.includes(wire)) out.push({ kind: "unadd", wire });
  for (const host of new Set([...Object.keys(base.order), ...Object.keys(draft.order)])) {
    if (JSON.stringify(base.order[host]) !== JSON.stringify(draft.order[host])) out.push({ kind: "order", host, seats: draft.order[host] });
  }
  return out;
}

export function replay(onto: WiringOverrides, list: readonly Edit[]): WiringOverrides {
  let next = normalize(onto);
  for (const edit of list) {
    switch (edit.kind) {
      case "unplug":
        next = { ...next, unplugged: [...new Set([...next.unplugged, edit.plugin])].sort() };
        break;
      case "plug":
        next = { ...next, unplugged: next.unplugged.filter((x) => x !== edit.plugin) };
        break;
      case "bind": {
        const bind = { ...next.bind };
        if (edit.to === undefined) delete bind[edit.port];
        else bind[edit.port] = edit.to;
        next = { ...next, bind };
        break;
      }
      case "cut":
        next = { ...next, cut: [...new Set([...next.cut, edit.wire])] };
        break;
      case "uncut":
        next = { ...next, cut: next.cut.filter((x) => x !== edit.wire) };
        break;
      case "add":
        next = { ...next, add: [...new Set([...next.add, edit.wire])] };
        break;
      case "unadd":
        next = { ...next, add: next.add.filter((x) => x !== edit.wire) };
        break;
      case "order": {
        const order = { ...next.order };
        if (edit.seats === undefined) delete order[edit.host];
        else order[edit.host] = [...edit.seats];
        next = { ...next, order };
        break;
      }
    }
  }
  return normalize(next);
}

export interface Rebase {
  readonly draft: WiringOverrides;
  /** The edits the new live version made on top of the old base, in words. */
  readonly liveChanged: readonly string[];
  /** Draft edits that touch something the new live version also changed. */
  readonly overlapping: readonly string[];
}

/** Re-apply a draft's edits on top of a newer live version (§6c: "live moved on"). */
export function rebase(oldBase: WiringOverrides, draft: WiringOverrides, newLive: LiveWiring | WiringOverrides): Rebase {
  const mine = edits(oldBase, draft);
  const theirs = edits(oldBase, newLive);
  const subject = (edit: Edit): string => {
    switch (edit.kind) {
      case "unplug":
      case "plug":
        return `plugin ${edit.plugin}`;
      case "bind":
        return `port ${edit.port}`;
      case "cut":
      case "uncut":
      case "add":
      case "unadd":
        return `wire ${edit.wire}`;
      case "order":
        return `seats ${edit.host}`;
    }
  };
  const touched = new Set(theirs.map(subject));
  return {
    draft: replay(newLive, mine),
    liveChanged: theirs.map(describeEdit),
    overlapping: mine.filter((edit) => touched.has(subject(edit))).map(describeEdit),
  };
}

export function describeEdit(edit: Edit): string {
  switch (edit.kind) {
    case "unplug":
      return `unplug ${edit.plugin}`;
    case "plug":
      return `plug in ${edit.plugin}`;
    case "bind":
      return edit.to === undefined
        ? `${edit.port}: automatic`
        : edit.to === null
          ? `${edit.port}: unbound`
          : `${edit.port} → ${nodeOfPort(edit.to)}`;
    case "cut":
      return `cut ${edit.wire}`;
    case "uncut":
      return `restore ${edit.wire}`;
    case "add":
      return `add ${edit.wire}`;
    case "unadd":
      return `remove ${edit.wire}`;
    case "order":
      return edit.seats ? `${edit.host} seats: ${edit.seats.map(nodeOfPort).join(", ")}` : `${edit.host} seats: default order`;
  }
}

/** The plugin ids a set of wire keys mention, for the change list's links. */
export const pluginsOfWires = (wires: readonly string[]): readonly string[] =>
  [...new Set(wires.flatMap((wire) => splitWireKey(wire).map(nodeOfPort)))].sort();
