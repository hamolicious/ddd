/**
 * The ports runtime (PLUGIN-PROTOCOLS §5): services, slots and events addressed by a
 * plugin's own port names, wired by the server's resolution.
 *
 * One store for every slot item, declared and legacy alike, so a plugin that has moved to
 * ports and one that has not still see each other (the 1.x shims, §5):
 *
 * - an item offered on a **declared** provided port reaches the hosts the resolution seats
 *   it on, in seat order;
 * - an item contributed through the legacy `extensions.contribute(point, …)` lands on an
 *   **implicit** port (`~<point>`) of protocol `lm/<point>`, and joins every host of that
 *   protocol after its wired seats, ordered by its `order` option;
 * - a legacy `definePoint` host sees every item of its protocol, declared or not, ordered
 *   the way the registry always ordered: `order`, then contribution sequence.
 *
 * Services: `serve` stores the API under the provider's port; `use` returns it through a
 * handle limited to the consumer port's `needs`. A legacy provider's `activate()` return
 * value is served on its declared service ports (and on the implicit `~<protocol>` port the
 * resolver gives a legacy owner), so either side can move first.
 *
 * The kernel still knows no domain: protocols are data it is handed with the plugin list.
 */

import {
  ContractViolationError,
  formatIssues,
  shapeFromJSON,
  splitProtocolRef,
  satisfies,
  validate,
  type Disposable,
  type ExtensionPointDefinition,
  type PluginManifest,
  type PortsApi,
  type ProtocolKind,
  type ProtocolPackage,
  type Resolution,
  type Shape,
  type SlotHost,
  type SlotItem,
  type Unsubscribe,
} from "@kernel";

/** Implicit port names start with this; a declared port name never contains it. */
export const IMPLICIT = "~";

/** The protocol a legacy point name speaks: point names carry over as protocol names (§8). */
export const protocolForPoint = (point: string): string => (point.includes("/") ? point : `lm/${point}`);

/** Default `order` for a legacy contribution that does not ask for one. */
const DEFAULT_ORDER = 100;

export interface PortsReport {
  readonly pluginId: string;
  /** The port key or point name the problem is about. */
  readonly point: string;
  readonly message: string;
}

export interface PortsConfig {
  readonly resolution: Resolution;
  readonly protocols: readonly ProtocolPackage[];
  /** Every served plugin's manifest: what declares each port. */
  readonly manifests: readonly PluginManifest[];
}

interface Offer {
  readonly pluginId: string;
  /** Declared port name, or `~<point>`. */
  readonly port: string;
  readonly key: string;
  readonly protocol: string;
  readonly value: unknown;
  /** The seat rank of an implicit offer; a declared offer's port hint. */
  readonly order: number;
  readonly seq: number;
}

interface LegacyPoint {
  readonly owner: string;
  readonly definition: ExtensionPointDefinition<unknown>;
  readonly protocol: string;
}

interface HostListener {
  readonly fn: (values: readonly unknown[]) => void;
  readonly pluginId: string | undefined;
  readonly protocol: string;
  readonly read: () => readonly SlotItem<unknown>[];
}

type EventListener = (payload: unknown, from: string) => void;

const EMPTY_RESOLUTION: Resolution = {
  order: [],
  skipped: [],
  wires: [],
  bindings: {},
  seats: {},
  bench: {},
  listeners: {},
  activation: [],
  diagnostics: [],
  status: {},
};

/** Keys a handle may be asked for without being a member: promise and JSON probes. */
const INTROSPECTION = new Set(["then", "toJSON", "$$typeof", "constructor", "asymmetricMatch", "nodeType"]);

export class PortsHost {
  #resolution: Resolution = EMPTY_RESOLUTION;
  /**
   * `false` until a resolution arrives. A plugin list from a server (or a cache) older than
   * wiring has none, and then every host hears every item of its protocol, ordered the way
   * the registry always did, so nothing disappears for want of seats.
   */
  #resolved = false;
  readonly #packages = new Map<string, ProtocolPackage>();
  readonly #byId = new Map<string, ProtocolPackage[]>();
  readonly #manifests = new Map<string, PluginManifest>();
  readonly #offers: Offer[] = [];
  readonly #served = new Map<string, unknown>();
  readonly #legacy = new Map<string, LegacyPoint>();
  readonly #listeners = new Set<HostListener>();
  readonly #eventListeners = new Map<string, Set<{ readonly fn: EventListener; readonly pluginId: string }>>();
  readonly #last = new Map<string, unknown>();
  readonly #handles = new Map<string, unknown>();
  readonly #shapes = new Map<string, Shape<unknown>>();
  readonly #reported = new Set<string>();
  #seq = 0;

  constructor(private readonly onReport?: (report: PortsReport) => void) {}

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  /** The plugin list and the server's resolution, before the first `activate`. */
  configure(config: PortsConfig | Omit<PortsConfig, "resolution">): void {
    this.#packages.clear();
    this.#byId.clear();
    for (const pkg of config.protocols) {
      this.#packages.set(`${pkg.id}@${pkg.version}`, pkg);
      const list = this.#byId.get(pkg.id) ?? [];
      list.push(pkg);
      list.sort((a, b) => compareVersions(a.version, b.version));
      this.#byId.set(pkg.id, list);
    }
    this.#manifests.clear();
    for (const manifest of config.manifests) this.#manifests.set(manifest.id, manifest);
    if ("resolution" in config) this.setResolution(config.resolution);
  }

  get resolution(): Resolution {
    return this.#resolution;
  }

  /** A new resolution (hot apply, §6c): handles are rebuilt and every host re-reads. */
  setResolution(resolution: Resolution): void {
    this.#resolution = resolution;
    this.#resolved = true;
    this.#handles.clear();
    for (const listener of [...this.#listeners]) this.#deliver(listener);
  }

  /** Register a manifest the plugin list did not carry (tests, the demo). */
  addManifest(manifest: PluginManifest): void {
    this.#manifests.set(manifest.id, manifest);
  }

  protocols(): readonly ProtocolPackage[] {
    return [...this.#packages.values()];
  }

  kindOf(protocolId: string): ProtocolKind | undefined {
    return this.#byId.get(protocolId)?.[0]?.kind;
  }

  // -------------------------------------------------------------------------
  // The per-plugin API
  // -------------------------------------------------------------------------

  forPlugin(manifest: PluginManifest): PortsApi {
    const pluginId = manifest.id;
    this.#manifests.set(pluginId, manifest);
    return {
      use: <T>(port: string): T => this.use<T>(pluginId, port),
      bound: (port: string) => this.#binding(pluginId, this.#consumed(pluginId, port, "service").name) !== undefined,
      serve: <T>(port: string, api: T): Disposable => this.serve(pluginId, port, api),
      offer: <T>(port: string, items: T | readonly T[]): Disposable => this.offer(pluginId, port, items),
      collect: <T>(port: string): SlotHost<T> => this.collect<T>(pluginId, port),
      emit: <P>(port: string, payload: P) => this.emit(pluginId, port, payload),
      on: <P>(port: string, listener: (payload: P, from: string) => void): Unsubscribe =>
        this.on(pluginId, port, listener as EventListener),
    };
  }

  use<T>(pluginId: string, port: string): T {
    const consumed = this.#consumed(pluginId, port, "service");
    const provider = this.#binding(pluginId, port);
    if (provider === undefined) {
      if (consumed.optional) return undefined as T;
      throw new ContractViolationError(`"${pluginId}" used its "${port}" port, which nothing is bound to`, {
        pluginId,
        port,
      });
    }
    const handleKey = `${pluginId}:${port}`;
    const cached = this.#handles.get(handleKey);
    if (cached !== undefined) return cached as T;
    if (!this.#served.has(provider)) {
      throw new ContractViolationError(`"${provider}", bound to "${pluginId}:${port}", serves nothing`, {
        pluginId,
        port,
        provider,
      });
    }
    const api = this.#served.get(provider);
    const members = this.#members(consumed.protocol);
    const allowed = new Set(consumed.needs ?? members ?? []);
    const handle = limited(api, allowed, members === undefined && consumed.needs === undefined, pluginId, port);
    this.#handles.set(handleKey, handle);
    return handle as T;
  }

  serve<T>(pluginId: string, port: string, api: T): Disposable {
    const provided = this.#provided(pluginId, port, "service");
    this.#check(pluginId, `${pluginId}:${port}`, provided.protocolKey, api);
    const key = `${pluginId}:${port}`;
    this.#served.set(key, api);
    this.#handles.clear();
    return {
      dispose: () => {
        if (this.#served.get(key) === api) this.#served.delete(key);
        this.#handles.clear();
      },
    };
  }

  offer<T>(pluginId: string, port: string, items: T | readonly T[]): Disposable {
    const provided = this.#provided(pluginId, port, "slot");
    const list = (Array.isArray(items) ? items : [items]) as readonly unknown[];
    for (const item of list) this.#check(pluginId, `${pluginId}:${port}`, provided.protocolKey, item);
    const offers = list.map((value) => this.#store(pluginId, port, provided.protocolId, value, provided.order));
    return this.#withdrawal(offers, provided.protocolId);
  }

  collect<T>(pluginId: string, port: string): SlotHost<T> {
    const consumed = this.#consumed(pluginId, port, "slot");
    const hostKey = `${pluginId}:${port}`;
    return this.#host<T>(consumed.protocolId, () => this.#declaredItems(hostKey, consumed), pluginId);
  }

  emit(pluginId: string, port: string, payload: unknown): void {
    const provided = this.#provided(pluginId, port, "event");
    this.#check(pluginId, `${pluginId}:${port}`, provided.protocolKey, payload);
    const key = `${pluginId}:${port}`;
    if (this.#packages.get(provided.protocolKey)?.sticky) this.#last.set(key, payload);
    for (const [listenerKey, emitters] of Object.entries(this.#resolution.listeners)) {
      if (!emitters.includes(key)) continue;
      for (const listener of [...(this.#eventListeners.get(listenerKey) ?? [])]) {
        this.#safely(listener.pluginId, listenerKey, () => listener.fn(payload, pluginId));
      }
    }
  }

  on(pluginId: string, port: string, listener: EventListener): Unsubscribe {
    const consumed = this.#consumed(pluginId, port, "event");
    const key = `${pluginId}:${port}`;
    const set = this.#eventListeners.get(key) ?? new Set();
    const entry = { fn: listener, pluginId };
    set.add(entry);
    this.#eventListeners.set(key, set);
    // Sticky: a new or restarted listener hears the last value of every emitter at once.
    if (this.#protocolIsSticky(consumed.protocolId)) {
      for (const emitter of this.#resolution.listeners[key] ?? []) {
        if (this.#last.has(emitter)) listener(this.#last.get(emitter), emitter.slice(0, emitter.lastIndexOf(":")));
      }
    }
    return () => {
      set.delete(entry);
      if (set.size === 0) this.#eventListeners.delete(key);
    };
  }

  // -------------------------------------------------------------------------
  // Legacy entry points (the 1.x shims, §5): `extensions.*` and `services.*`
  // -------------------------------------------------------------------------

  /**
   * `extensions.contribute(point, value, { order })`. On the plugin's declared port for the
   * point's protocol when it has one (the port whose `order` hint matches the value's own,
   * when several do), else on the implicit `~<point>` port.
   */
  contributeLegacy(pluginId: string, point: string, value: unknown, order: number | undefined): Disposable {
    const protocol = protocolForPoint(point);
    const declared = this.#declaredPortFor(pluginId, protocol, "provides", value);
    if (declared) return this.offer(pluginId, declared, value);

    const legacy = this.#legacy.get(point);
    if (legacy?.definition.shape) {
      const issues = validate(legacy.definition.shape, value);
      if (issues.length > 0) {
        throw new ContractViolationError(
          `contribution to "${point}" from "${pluginId}" is malformed: ${formatIssues(issues)}`,
          { point, pluginId },
        );
      }
    }
    const pkg = this.#newest(protocol);
    if (pkg && !legacy) this.#check(pluginId, point, `${pkg.id}@${pkg.version}`, value);
    if (legacy?.definition.key) {
      const key = safeKey(legacy.definition.key, value);
      const holder = key === undefined ? undefined : this.#legacyItems(point).find((item) => safeKey(legacy.definition.key!, item.value) === key);
      if (holder) {
        this.#report({ pluginId, point, message: `Two plugins claim “${key}”. ${holder.pluginId} is being used.` });
        return { dispose: () => undefined };
      }
    }
    const offer = this.#store(pluginId, `${IMPLICIT}${point}`, protocol, value, order ?? DEFAULT_ORDER);
    return this.#withdrawal([offer], protocol);
  }

  /** `extensions.definePoint(definition)`: a legacy host. Throws on a second owner. */
  defineLegacy<T>(owner: string, definition: ExtensionPointDefinition<T>): SlotHost<T> {
    const existing = this.#legacy.get(definition.name);
    if (existing) {
      throw new ContractViolationError(
        `extension point "${definition.name}" is already defined by "${existing.owner}"`,
        { point: definition.name, owner: existing.owner, attemptedBy: owner },
      );
    }
    const protocol = protocolForPoint(definition.name);
    this.#legacy.set(definition.name, { owner, definition: definition as ExtensionPointDefinition<unknown>, protocol });
    // Buffered contributions meet the shape and the key now, exactly as they would have at
    // `contribute` time: a malformed one is dropped and reported, a duplicate loses to the
    // earlier one.
    const claimed = new Map<string, string>();
    for (const offer of this.#offers.filter((o) => o.port === `${IMPLICIT}${definition.name}`)) {
      const issues = definition.shape ? validate(definition.shape, offer.value) : [];
      if (issues.length > 0) {
        this.#remove(offer);
        this.#report({
          pluginId: offer.pluginId,
          point: definition.name,
          message: `buffered contribution is malformed and was dropped: ${formatIssues(issues)}`,
        });
        continue;
      }
      const key = definition.key ? safeKey(definition.key as (value: unknown) => string, offer.value) : undefined;
      if (key === undefined) continue;
      const winner = claimed.get(key);
      if (winner !== undefined) {
        this.#remove(offer);
        this.#report({ pluginId: offer.pluginId, point: definition.name, message: `Two plugins claim “${key}”. ${winner} is being used.` });
        continue;
      }
      claimed.set(key, offer.pluginId);
    }
    this.#notify(protocol);
    return this.viewOf<T>(definition.name, owner);
  }

  /**
   * What `extensions.get/entries/subscribe(point)` reads for `pluginId`: its own declared
   * host for the protocol when it has one, else the legacy host's view, else every item of
   * the protocol.
   */
  viewOf<T>(point: string, pluginId: string | undefined): SlotHost<T> {
    const protocol = protocolForPoint(point);
    if (pluginId !== undefined) {
      const declared = this.#declaredPortFor(pluginId, protocol, "consumes");
      if (declared) return this.collect<T>(pluginId, declared);
    }
    const owner = this.#declaredHostOf(protocol);
    if (!this.#legacy.has(point) && owner) {
      const [host, port] = owner;
      const consumed = this.#consumed(host, port, "slot");
      return this.#host<T>(protocol, () => this.#declaredItems(`${host}:${port}`, consumed), pluginId);
    }
    return this.#host<T>(protocol, () => this.#legacyItems(point), pluginId);
  }

  /** Whether anything hosts `point`: a legacy owner, or a declared port of its protocol. */
  isHosted(point: string): boolean {
    return this.#legacy.has(point) || this.#declaredHostOf(protocolForPoint(point)) !== undefined;
  }

  legacyOwner(point: string): string | undefined {
    return this.#legacy.get(point)?.owner ?? this.#declaredHostOf(protocolForPoint(point))?.[0];
  }

  /** Every hosted point name, sorted: legacy owners, and the names of hosted protocols. */
  hostedPoints(): readonly string[] {
    const names = new Set(this.#legacy.keys());
    for (const manifest of this.#manifests.values()) {
      for (const port of Object.values(manifest.consumes ?? {})) {
        const [id] = splitProtocolRef(port.protocol);
        if (this.kindOf(id) === "slot" && id.startsWith("lm/")) names.add(id.slice(3));
      }
    }
    return [...names].sort();
  }

  /** Legacy contributions nothing hosts yet. */
  pendingLegacy(): readonly { readonly point: string; readonly pluginId: string; readonly value: unknown; readonly order: number }[] {
    return this.#offers
      .filter((offer) => offer.port.startsWith(IMPLICIT))
      .map((offer) => ({ point: offer.port.slice(IMPLICIT.length), pluginId: offer.pluginId, value: offer.value, order: offer.order }))
      .filter((offer) => !this.isHosted(offer.point));
  }

  /**
   * A legacy provider's `activate()` return value: served on each of its declared service
   * ports it has not served itself, and on the implicit `~<protocol>` ports the resolver
   * gave it as a legacy owner.
   */
  adoptLegacyApi(pluginId: string, api: unknown): void {
    if (api === undefined || api === null) return;
    const manifest = this.#manifests.get(pluginId);
    for (const [port, provided] of Object.entries(manifest?.provides ?? {})) {
      const [id] = splitProtocolRef(provided.protocol);
      if (this.kindOf(id) !== "service" || this.#served.has(`${pluginId}:${port}`)) continue;
      this.serve(pluginId, port, api);
    }
    for (const provider of Object.values(this.#resolution.bindings)) {
      if (provider.startsWith(`${pluginId}:${IMPLICIT}`) && !this.#served.has(provider)) {
        this.#served.set(provider, api);
      }
    }
    this.#handles.clear();
  }

  /** The API a plugin serves, for a legacy `services.require` of it: its first served port. */
  servedBy(pluginId: string): unknown {
    for (const [key, api] of this.#served) if (key.startsWith(`${pluginId}:`)) return api;
    return undefined;
  }

  /**
   * `services.require(wanted)` from a plugin that declares ports: the consumed service port
   * bound to `wanted`, as `use()` returns it. `undefined` when no port of the caller is
   * bound to that plugin.
   */
  legacyUse(pluginId: string, wanted: string): { readonly found: boolean; readonly api?: unknown } {
    // Without a resolution nothing is bound: the legacy registry answers by plugin id.
    if (!this.#resolved) return { found: false };
    const manifest = this.#manifests.get(pluginId);
    for (const [port, consumed] of Object.entries(manifest?.consumes ?? {})) {
      const [id] = splitProtocolRef(consumed.protocol);
      if (this.kindOf(id) !== "service") continue;
      const provider = this.#binding(pluginId, port);
      if (provider?.startsWith(`${wanted}:`)) return { found: true, api: this.use(pluginId, port) };
      // The port exists but is unbound right now (optional, or its provider is off): the
      // legacy call asked for exactly this plugin, so it is answered as absent.
      if (provider === undefined && this.#ownerOf(id) === wanted) return { found: true };
    }
    return { found: false };
  }

  /** Withdraw everything a plugin registered: offers, services, listeners, legacy points. */
  removePlugin(pluginId: string): void {
    const touched = new Set<string>();
    for (const offer of [...this.#offers]) {
      if (offer.pluginId !== pluginId) continue;
      this.#remove(offer);
      touched.add(offer.protocol);
    }
    for (const [point, legacy] of [...this.#legacy]) {
      if (legacy.owner !== pluginId) continue;
      this.#legacy.delete(point);
      touched.add(legacy.protocol);
    }
    for (const key of [...this.#served.keys()]) if (key.startsWith(`${pluginId}:`)) this.#served.delete(key);
    for (const key of [...this.#eventListeners.keys()]) if (key.startsWith(`${pluginId}:`)) this.#eventListeners.delete(key);
    for (const listener of [...this.#listeners]) if (listener.pluginId === pluginId) this.#listeners.delete(listener);
    this.#handles.clear();
    for (const protocol of touched) this.#notify(protocol);
  }

  /** Items offered by the kernel itself (a settings section only the shell has). */
  offerAsKernel(protocol: string, value: unknown, order = DEFAULT_ORDER): Disposable {
    const offer = this.#store("kernel", `${IMPLICIT}${protocol.replace(/^lm\//, "")}`, protocol, value, order);
    return this.#withdrawal([offer], protocol);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #store(pluginId: string, port: string, protocol: string, value: unknown, order: number): Offer {
    const offer: Offer = { pluginId, port, key: `${pluginId}:${port}`, protocol, value, order, seq: this.#seq++ };
    this.#offers.push(offer);
    this.#notify(protocol);
    return offer;
  }

  #remove(offer: Offer): void {
    const index = this.#offers.indexOf(offer);
    if (index >= 0) this.#offers.splice(index, 1);
  }

  #withdrawal(offers: readonly Offer[], protocol: string): Disposable {
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        for (const offer of offers) this.#remove(offer);
        this.#notify(protocol);
      },
    };
  }

  #declaredItems(
    hostKey: string,
    consumed: { readonly protocolId: string; readonly needShape: Shape<unknown> | undefined },
  ): readonly SlotItem<unknown>[] {
    if (!this.#resolved) {
      const items = this.#offers
        .filter((offer) => offer.protocol === consumed.protocolId)
        .sort((a, b) => a.order - b.order || a.seq - b.seq)
        .map((offer) => ({ pluginId: offer.pluginId, port: offer.port, value: offer.value }));
      return this.#dedupe(consumed.protocolId, hostKey, items, undefined);
    }
    const out: { pluginId: string; port: string; value: unknown }[] = [];
    const byShape = new Set(
      this.#resolution.wires.filter((wire) => wire.to === hostKey && wire.byShape).map((wire) => wire.from),
    );
    for (const seat of this.#resolution.seats[hostKey] ?? []) {
      for (const offer of this.#offers) {
        if (offer.key !== seat) continue;
        if (byShape.has(seat) && consumed.needShape && !this.#fits(consumed.needShape, offer, hostKey)) continue;
        out.push({ pluginId: offer.pluginId, port: offer.port, value: offer.value });
      }
    }
    // Legacy contributions to this protocol, after the wired seats.
    const implicit = this.#offers
      .filter((offer) => offer.port.startsWith(IMPLICIT) && offer.protocol === consumed.protocolId)
      .sort((a, b) => a.order - b.order || a.seq - b.seq);
    for (const offer of implicit) {
      if (consumed.needShape && !this.#fits(consumed.needShape, offer, hostKey)) continue;
      out.push({ pluginId: offer.pluginId, port: offer.port, value: offer.value });
    }
    return this.#dedupe(consumed.protocolId, hostKey, out, undefined);
  }

  #legacyItems(point: string): readonly SlotItem<unknown>[] {
    const protocol = protocolForPoint(point);
    const legacy = this.#legacy.get(point);
    const items = this.#offers
      .filter((offer) => offer.protocol === protocol)
      .sort((a, b) => a.order - b.order || a.seq - b.seq)
      .map((offer) => ({ pluginId: offer.pluginId, port: offer.port, value: offer.value }));
    return this.#dedupe(protocol, point, items, legacy?.definition.key);
  }

  #dedupe(
    protocol: string,
    where: string,
    items: readonly SlotItem<unknown>[],
    keyFn: ((value: unknown) => string) | undefined,
  ): readonly SlotItem<unknown>[] {
    const fields = this.#keyFields(protocol);
    const keyOf = keyFn
      ? (value: unknown) => safeKey(keyFn, value)
      : fields
        ? (value: unknown) =>
            typeof value === "object" && value !== null
              ? fields.map((field) => String((value as Record<string, unknown>)[field])).join("|")
              : undefined
        : undefined;
    if (!keyOf) return items;
    const seen = new Map<string, string>();
    const out: SlotItem<unknown>[] = [];
    for (const item of items) {
      const key = keyOf(item.value);
      if (key === undefined) {
        out.push(item);
        continue;
      }
      const winner = seen.get(key);
      if (winner !== undefined) {
        this.#reportOnce(`${where}|${key}|${item.pluginId}`, {
          pluginId: item.pluginId,
          point: where,
          message: `Two plugins claim “${key}”. ${winner} is being used.`,
        });
        continue;
      }
      seen.set(key, item.pluginId);
      out.push(item);
    }
    return out;
  }

  #fits(shape: Shape<unknown>, offer: Offer, hostKey: string): boolean {
    const issues = validate(shape, offer.value);
    if (issues.length === 0) return true;
    this.#reportOnce(`${hostKey}|${offer.seq}`, {
      pluginId: offer.pluginId,
      point: hostKey,
      message: `an item does not fit ${hostKey} and was left out: ${formatIssues(issues)}`,
    });
    return false;
  }

  #host<T>(protocol: string, read: () => readonly SlotItem<unknown>[], pluginId: string | undefined): SlotHost<T> {
    return {
      get: () => read().map((item) => item.value as T),
      entries: () => read() as readonly SlotItem<T>[],
      subscribe: (fn) => {
        const listener: HostListener = { fn: fn as (values: readonly unknown[]) => void, pluginId, protocol, read };
        this.#listeners.add(listener);
        // Immediately, in the subscriber's own stack: a throw here is theirs to see.
        fn(read().map((item) => item.value as T));
        return () => void this.#listeners.delete(listener);
      },
    };
  }

  #notify(protocol: string): void {
    for (const listener of [...this.#listeners]) if (listener.protocol === protocol) this.#deliver(listener);
  }

  #deliver(listener: HostListener): void {
    if (!this.#listeners.has(listener)) return;
    this.#safely(listener.pluginId ?? "kernel", listener.protocol, () => listener.fn(listener.read().map((item) => item.value)));
  }

  #safely(pluginId: string, point: string, call: () => void): void {
    try {
      call();
    } catch (error) {
      this.#report({
        pluginId,
        point,
        message: `a subscriber threw while being notified: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  #report(report: PortsReport): void {
    this.onReport?.(report);
  }

  #reportOnce(key: string, report: PortsReport): void {
    if (this.#reported.has(key)) return;
    this.#reported.add(key);
    this.#report(report);
  }

  /** Check a value against a protocol version's whole shape; throws at the provider. */
  #check(pluginId: string, where: string, protocolKey: string, value: unknown): void {
    const shape = this.#shapeOf(protocolKey);
    if (!shape) return;
    const issues = validate(shape, value);
    if (issues.length > 0) {
      throw new ContractViolationError(`"${pluginId}" offered ${where} something that does not match ${protocolKey}: ${formatIssues(issues)}`, {
        pluginId,
        port: where,
        protocol: protocolKey,
      });
    }
  }

  #shapeOf(protocolKey: string): Shape<unknown> | undefined {
    const cached = this.#shapes.get(protocolKey);
    if (cached) return cached;
    const pkg = this.#packages.get(protocolKey);
    if (!pkg) return undefined;
    const shape = shapeFromJSON(pkg.shape);
    this.#shapes.set(protocolKey, shape);
    return shape;
  }

  #newest(protocolId: string): ProtocolPackage | undefined {
    return this.#byId.get(protocolId)?.at(-1);
  }

  #ownerOf(protocolId: string): string | undefined {
    return this.#newest(protocolId)?.owner;
  }

  #protocolIsSticky(protocolId: string): boolean {
    return this.#byId.get(protocolId)?.some((pkg) => pkg.sticky) ?? false;
  }

  #keyFields(protocolId: string): readonly string[] | undefined {
    const key = this.#newest(protocolId)?.key;
    return key === undefined ? undefined : typeof key === "string" ? [key] : key;
  }

  /** The members a consumer may read when it names no `needs`: the protocol's own keys. */
  #members(protocolId: string): readonly string[] | undefined {
    const shape = this.#newest(protocolId)?.shape;
    return shape && typeof shape === "object" && "object" in shape ? Object.keys(shape.object) : undefined;
  }

  #binding(pluginId: string, port: string): string | undefined {
    return this.#resolution.bindings[`${pluginId}:${port}`];
  }

  #declaredHostOf(protocolId: string): readonly [string, string] | undefined {
    const owner = this.#ownerOf(protocolId);
    const hosts: [string, string][] = [];
    for (const manifest of this.#manifests.values()) {
      for (const [port, consumed] of Object.entries(manifest.consumes ?? {})) {
        if (splitProtocolRef(consumed.protocol)[0] === protocolId) hosts.push([manifest.id, port]);
      }
    }
    hosts.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    return hosts.find(([id]) => id === owner) ?? hosts[0];
  }

  #declaredPortFor(
    pluginId: string,
    protocolId: string,
    side: "provides" | "consumes",
    value?: unknown,
  ): string | undefined {
    const ports = Object.entries(this.#manifests.get(pluginId)?.[side] ?? {})
      .filter(([, port]) => splitProtocolRef(port.protocol)[0] === protocolId)
      .map(([name, port]) => ({ name, order: (port as { order?: number }).order }));
    if (ports.length <= 1) return ports[0]?.name;
    const wanted = (value as { order?: unknown } | null)?.order;
    return (ports.find((port) => port.order === wanted) ?? ports[0])?.name;
  }

  #consumed(
    pluginId: string,
    port: string,
    kind: ProtocolKind,
  ): {
    readonly name: string;
    readonly protocolId: string;
    readonly protocol: string;
    readonly needs: readonly string[] | undefined;
    readonly optional: boolean;
    readonly needShape: Shape<unknown> | undefined;
  } {
    const declared = this.#manifests.get(pluginId)?.consumes?.[port];
    if (!declared) {
      throw new ContractViolationError(`"${pluginId}" has no consumed port "${port}"`, { pluginId, port });
    }
    const [protocolId, range] = splitProtocolRef(declared.protocol);
    const actual = this.kindOf(protocolId);
    if (actual !== undefined && actual !== kind) {
      throw new ContractViolationError(`"${pluginId}:${port}" is a ${actual} port, not a ${kind} port`, { pluginId, port });
    }
    const floor = this.#byId.get(protocolId)?.find((pkg) => satisfies(pkg.version, range));
    const needShape = floor ? this.#needShape(floor, declared.needs) : undefined;
    return {
      name: port,
      protocolId,
      protocol: protocolId,
      needs: declared.needs,
      optional: declared.optional ?? false,
      needShape,
    };
  }

  #needShape(pkg: ProtocolPackage, needs: readonly string[] | undefined): Shape<unknown> {
    if (!needs || typeof pkg.shape !== "object" || !("object" in pkg.shape)) return this.#shapeOf(`${pkg.id}@${pkg.version}`)!;
    const fields = pkg.shape.object;
    return shapeFromJSON({ object: Object.fromEntries(needs.filter((k) => k in fields).map((k) => [k, fields[k]!])) });
  }

  #provided(
    pluginId: string,
    port: string,
    kind: ProtocolKind,
  ): { readonly protocolId: string; readonly protocolKey: string; readonly order: number } {
    const declared = this.#manifests.get(pluginId)?.provides?.[port];
    if (!declared) {
      throw new ContractViolationError(`"${pluginId}" has no provided port "${port}"`, { pluginId, port });
    }
    const [protocolId] = splitProtocolRef(declared.protocol);
    const actual = this.kindOf(protocolId);
    if (actual !== undefined && actual !== kind) {
      throw new ContractViolationError(`"${pluginId}:${port}" is a ${actual} port, not a ${kind} port`, { pluginId, port });
    }
    return { protocolId, protocolKey: declared.protocol, order: declared.order ?? DEFAULT_ORDER };
  }
}

/**
 * A service handle limited to `allowed`. Reading a member outside it throws; promise and
 * JSON probes (`then`, `toJSON`) read as absent, so awaiting or logging a handle does not.
 * With nothing known about the protocol and no `needs`, everything is allowed.
 */
function limited(api: unknown, allowed: ReadonlySet<string>, open: boolean, pluginId: string, port: string): unknown {
  if (open || api === null || (typeof api !== "object" && typeof api !== "function")) return api;
  return new Proxy(api as object, {
    get(target, key) {
      if (typeof key === "symbol") return Reflect.get(target, key, target);
      if (allowed.has(key)) return Reflect.get(target, key, target);
      if (INTROSPECTION.has(key)) return undefined;
      throw new ContractViolationError(
        `"${pluginId}" read "${key}" through its "${port}" port, which is not in that port's needs`,
        { pluginId, port, key },
      );
    },
    set(_target, key) {
      throw new ContractViolationError(`"${pluginId}" wrote "${String(key)}" through its "${port}" port`, { pluginId, port });
    },
  });
}

function safeKey(key: (value: never) => string, value: unknown): string | undefined {
  try {
    return key(value as never);
  } catch {
    return undefined;
  }
}

function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.split(/[-+]/)[0] ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
