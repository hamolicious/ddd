/**
 * The extension registry — the one piece of the microkernel that is *not* a thin
 * wrapper over something else, and the reason the base distribution is replaceable
 * (SPEC §6.1, §6.4).
 *
 * Implemented here rather than stubbed because its four behaviours are the plugin
 * graph's contract, and every builder's area depends on all four being true from
 * the first commit:
 *
 * 1. contributions to an undefined point **buffer** and arrive when it is defined;
 * 2. a duplicate `definePoint` **throws**;
 * 3. `get`/`subscribe` are **live**;
 * 4. shape validation **rejects loudly**, attributed to the contributing plugin.
 *
 * Two containment rules hold on top of those, for the same reason the loader owns
 * dependency order — the guarantees have to survive code the kernel did not write:
 * a **retracted plugin releases the points it defined** as well as its contributions
 * (`removePlugin`), and **every notification is isolated** so one plugin's throwing
 * listener neither silences the others nor surfaces as a failure of whoever happened
 * to be contributing at the time (`#emit`).
 *
 * Ordering is `order` ascending, then contribution sequence — never insertion into
 * an array, because a plugin that re-contributes (a live settings change) must not
 * jump to the end of the navbar.
 */

import {
  ContractViolationError,
  DEFAULT_CONTRIBUTION_ORDER,
  formatIssues,
  validate,
  type Contribution,
  type ContributeOptions,
  type Disposable,
  type ExtensionPoint,
  type ExtensionPointDefinition,
  type ExtensionsApi,
  type Unsubscribe,
} from "@kernel";

interface Entry {
  readonly point: string;
  readonly pluginId: string;
  readonly value: unknown;
  readonly order: number;
  /** Monotonic, for stable ties. */
  readonly seq: number;
}

interface PointState {
  readonly definition: ExtensionPointDefinition<unknown>;
  readonly owner: string;
}

/**
 * A subscriber, with the plugin to blame if it throws.
 *
 * `pluginId` is `undefined` for the kernel's own subscriptions (the app frame, a
 * built-in view); everything a plugin subscribes through `forPlugin` carries its id,
 * so a throwing listener is reported against the plugin that wrote it rather than
 * against whoever happened to contribute at the time.
 */
interface Listener {
  readonly fn: (values: readonly unknown[]) => void;
  readonly pluginId: string | undefined;
}

export interface RegistryReport {
  /** A contribution rejected by shape validation, or a duplicate key. */
  readonly pluginId: string;
  readonly point: string;
  readonly message: string;
}

export class ExtensionRegistry {
  readonly #points = new Map<string, PointState>();
  readonly #entries = new Map<string, Entry[]>();
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #reports: RegistryReport[] = [];
  #seq = 0;

  constructor(private readonly onReport?: (report: RegistryReport) => void) {}

  /** Rejections so far — the aggregated notice and the admin view read this. */
  get reports(): readonly RegistryReport[] {
    return this.#reports;
  }

  definePoint<T>(owner: string, definition: ExtensionPointDefinition<T>): ExtensionPoint<T> {
    const existing = this.#points.get(definition.name);
    if (existing) {
      throw new ContractViolationError(
        `extension point "${definition.name}" is already defined by "${existing.owner}"`,
        { point: definition.name, owner: existing.owner, attemptedBy: owner },
      );
    }
    this.#points.set(definition.name, {
      definition: definition as ExtensionPointDefinition<unknown>,
      owner,
    });

    // Buffered contributions are validated now — the point did not exist when they
    // arrived, so this is the first moment either their shape or their key is
    // knowable. Both rules apply exactly as they would have at `contribute` time:
    // a malformed one is dropped and reported, and a duplicate key loses to the
    // earlier contribution rather than sneaking past because it arrived early.
    const buffered = this.#entries.get(definition.name) ?? [];
    const kept: Entry[] = [];
    const claimed = new Map<string, string>();
    for (const entry of buffered) {
      if (!this.#accepts(definition.name, entry)) continue;
      const key = this.#keyOf(definition.name, entry.value);
      if (key !== undefined) {
        const winner = claimed.get(key);
        if (winner !== undefined) {
          this.#report({
            pluginId: entry.pluginId,
            point: definition.name,
            message: `duplicate key "${key}" — the contribution from "${winner}" wins`,
          });
          continue;
        }
        claimed.set(key, entry.pluginId);
      }
      kept.push(entry);
    }
    if (kept.length !== buffered.length) this.#entries.set(definition.name, kept);
    if (buffered.length > 0) this.#emit(definition.name);

    return this.#handle(definition.name);
  }

  contribute<T>(
    pluginId: string,
    point: string,
    value: T,
    options: ContributeOptions = {},
  ): Disposable {
    const entry: Entry = {
      point,
      pluginId,
      value,
      order: options.order ?? DEFAULT_CONTRIBUTION_ORDER,
      seq: this.#seq++,
    };

    // A defined point validates immediately and throws at the contributor: the
    // stack trace is the only place the mistake is cheap to find.
    if (this.#points.has(point)) {
      const issues = this.#issues(point, value);
      if (issues) {
        throw new ContractViolationError(
          `contribution to "${point}" from "${pluginId}" is malformed: ${issues}`,
          { point, pluginId },
        );
      }
      const duplicate = this.#duplicateKey(point, entry);
      if (duplicate !== undefined) {
        // First registration wins (the `commands` conflict rule, SPEC §6.5), and
        // the loser is reported rather than silently dropped.
        this.#report({
          pluginId,
          point,
          message: `duplicate key "${duplicate}" — the contribution from "${this.#owningPluginOfKey(point, duplicate)}" wins`,
        });
        return { dispose: () => undefined };
      }
    }

    const list = this.#entries.get(point);
    if (list) list.push(entry);
    else this.#entries.set(point, [entry]);
    if (this.#points.has(point)) this.#emit(point);

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        const current = this.#entries.get(point);
        if (!current) return;
        const index = current.indexOf(entry);
        if (index < 0) return;
        current.splice(index, 1);
        if (this.#points.has(point)) this.#emit(point);
      },
    };
  }

  get<T>(point: string): readonly T[] {
    return this.#sorted(point).map((entry) => entry.value as T);
  }

  entries<T>(point: string): readonly Contribution<T>[] {
    return this.#sorted(point).map((entry) => ({
      point: entry.point,
      pluginId: entry.pluginId,
      value: entry.value as T,
      order: entry.order,
    }));
  }

  /**
   * Live subscription. `subscriberId` is the plugin the listener belongs to, used only
   * to attribute a throw (see {@link ExtensionRegistry.#emit}).
   *
   * The **immediate** first call is deliberately *not* isolated: it runs inside the
   * subscriber's own `subscribe()` call, so a throw there lands in the stack of the
   * code that wrote the listener, which is where it is cheap to find. Later calls come
   * from someone else's `contribute()` and are isolated.
   */
  subscribe<T>(
    point: string,
    listener: (values: readonly T[]) => void,
    subscriberId?: string,
  ): Unsubscribe {
    const set = this.#listeners.get(point) ?? new Set();
    this.#listeners.set(point, set);
    const entry: Listener = {
      fn: listener as (values: readonly unknown[]) => void,
      pluginId: subscriberId,
    };
    set.add(entry);
    // Fires immediately: a panel must not need a change to render its first frame.
    listener(this.get<T>(point));
    return () => {
      set.delete(entry);
      if (set.size === 0) this.#listeners.delete(point);
    };
  }

  isDefined(point: string): boolean {
    return this.#points.has(point);
  }

  points(): readonly string[] {
    return [...this.#points.keys()].sort();
  }

  owner(point: string): string | undefined {
    return this.#points.get(point)?.owner;
  }

  pending(): readonly Contribution<unknown>[] {
    const out: Contribution<unknown>[] = [];
    for (const [point, entries] of this.#entries) {
      if (this.#points.has(point)) continue;
      for (const entry of entries) {
        out.push({ point, pluginId: entry.pluginId, value: entry.value, order: entry.order });
      }
    }
    return out;
  }

  /**
   * Drop everything a failed or unloaded plugin registered — its contributions **and
   * the points it defined**.
   *
   * Releasing the points is the half that is easy to forget and impossible to work
   * around. A plugin that defined `commands.command` and then threw has a dead owner;
   * leaving the definition in place would mean `isDefined("commands.command")` keeps
   * answering `true` (so a dependent that feature-detects takes the wrong branch),
   * `owner()` keeps naming a plugin that never finished activating, and — because a
   * duplicate `definePoint` throws — nothing could ever claim that name again in this
   * session, which is exactly what a replacement plugin needs to do.
   *
   * Contributions *to* a released point are not discarded: they return to the buffered
   * state they were in before it was defined (SPEC §6.4 — "contributions to undefined
   * points buffer until defined"), so whoever defines it next receives them and
   * re-validates them against their own shape.
   */
  removePlugin(pluginId: string): void {
    const touched = new Set<string>();
    for (const [point, state] of [...this.#points]) {
      if (state.owner !== pluginId) continue;
      this.#points.delete(point);
      touched.add(point);
    }
    for (const [point, entries] of [...this.#entries]) {
      const kept = entries.filter((entry) => entry.pluginId !== pluginId);
      if (kept.length === entries.length) continue;
      this.#entries.set(point, kept);
      touched.add(point);
    }
    // One notification per affected point, after both maps are consistent: a listener
    // that re-reads the registry must never see a half-retracted state.
    for (const point of touched) this.#emit(point);
  }

  /** The per-plugin `ExtensionsApi` facade handed to `activate()`. */
  forPlugin(pluginId: string): ExtensionsApi {
    return {
      definePoint: (definition) => this.definePoint(pluginId, definition),
      contribute: (point, value, options) => this.contribute(pluginId, point, value, options),
      get: (point) => this.get(point),
      entries: (point) => this.entries(point),
      subscribe: (point, listener) => this.subscribe(point, listener, pluginId),
      isDefined: (point) => this.isDefined(point),
      points: () => this.points(),
      pending: () => this.pending(),
    };
  }

  // -------------------------------------------------------------------------

  #handle<T>(name: string): ExtensionPoint<T> {
    return {
      name,
      get: () => this.get<T>(name),
      entries: () => this.entries<T>(name),
      subscribe: (listener) => this.subscribe<T>(name, listener),
    };
  }

  #sorted(point: string): readonly Entry[] {
    const entries = this.#entries.get(point);
    if (!entries || entries.length === 0) return [];
    return [...entries].sort((a, b) => (a.order !== b.order ? a.order - b.order : a.seq - b.seq));
  }

  #issues(point: string, value: unknown): string | undefined {
    const shape = this.#points.get(point)?.definition.shape;
    if (!shape) return undefined;
    const issues = validate(shape, value);
    return issues.length > 0 ? formatIssues(issues) : undefined;
  }

  #keyOf(point: string, value: unknown): string | undefined {
    const key = this.#points.get(point)?.definition.key;
    if (!key) return undefined;
    try {
      return key(value);
    } catch {
      return undefined;
    }
  }

  #duplicateKey(point: string, entry: Entry): string | undefined {
    const key = this.#keyOf(point, entry.value);
    if (key === undefined) return undefined;
    const clash = this.#sorted(point).some((other) => this.#keyOf(point, other.value) === key);
    return clash ? key : undefined;
  }

  #owningPluginOfKey(point: string, key: string): string {
    const match = this.#sorted(point).find((entry) => this.#keyOf(point, entry.value) === key);
    return match?.pluginId ?? "unknown";
  }

  /** Validate a buffered contribution now that the point exists. */
  #accepts(point: string, entry: Entry): boolean {
    const issues = this.#issues(point, entry.value);
    if (issues) {
      this.#report({
        pluginId: entry.pluginId,
        point,
        message: `buffered contribution is malformed and was dropped: ${issues}`,
      });
      return false;
    }
    return true;
  }

  /**
   * Notify every subscriber, **isolating each one**.
   *
   * Two failures this prevents, both of which used to be one throw away. A listener
   * that throws must not (1) stop the listeners registered after it from hearing the
   * change — one plugin's bug silently freezing the navbar for the rest of the session
   * — nor (2) escape into whichever plugin's `contribute()` or `definePoint()` caused
   * the emit, which made the loader mark an innocent plugin failed and skip its
   * dependents with an error message naming somebody else's bug.
   *
   * A throw is reported like any other contract violation (`onReport`), attributed to
   * the subscribing plugin.
   */
  #emit(point: string): void {
    const listeners = this.#listeners.get(point);
    if (!listeners || listeners.size === 0) return;
    const values = this.get(point);
    for (const listener of [...listeners]) {
      try {
        listener.fn(values);
      } catch (error) {
        this.#report({
          pluginId: listener.pluginId ?? "kernel",
          point,
          message: `a subscriber threw while being notified: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  #report(report: RegistryReport): void {
    this.#reports.push(report);
    this.onReport?.(report);
  }
}
