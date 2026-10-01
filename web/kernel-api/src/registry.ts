/**
 * `createRegistry` — how a host plugin takes contributions from the plugins that depend on
 * it (`@kernel` 3.0), and `checked` — opt-in argument validation for an exported function.
 *
 * A host keeps a registry at **module scope** and exports its `add`:
 *
 * ```ts
 * const items = createRegistry<NavbarItem>({ key: (i) => i.id, order: (i) => i.order ?? 100 });
 * export const addItem = items.add;          // toolbar.addItem(item) → unregister
 * ```
 *
 * A dependent calls it from its own `activate`, which always runs after the host's. The host
 * owns ordering (`order`, then insertion) and renders `entries()`, whose `pluginId` says who
 * contributed each item so a render failure is attributed to the right plugin.
 *
 * **Attribution.** The loader marks which plugin is being imported and activated; an item
 * added meanwhile is that plugin's. Later additions (from an event handler, say) fall back
 * to the part of the item's key before the first `.` — the `<plugin>.<name>` id convention —
 * and to `"unknown"` without one. The marker and the list of live registries live on
 * `globalThis` under `Symbol.for` keys, not in this module, so they are shared by every copy
 * of `@kernel` a page might end up with.
 *
 * **FROZEN.** New in 3.0.0.
 */

import { ContractViolationError } from "./errors.js";
import { formatIssues, type BuiltShape, type Shape } from "./shape.js";
import type { Unsubscribe } from "./types.js";

/** One item with the plugin that contributed it. */
export interface RegistryEntry<T> {
  readonly value: T;
  readonly pluginId: string;
}

export interface Registry<T> {
  /**
   * Add one item or several; returns the function that removes them again. An item whose
   * `key` matches an earlier one replaces it.
   */
  add(items: T | readonly T[]): () => void;
  /** Current values, sorted by `order` (then insertion). */
  get(): readonly T[];
  /**
   * The same, with attribution: the plugin whose import or `activate` was running when the
   * item was added, else the `key` prefix before the first `.`, else `"unknown"`.
   */
  entries(): readonly RegistryEntry<T>[];
  /** Fires immediately, then after every change. */
  subscribe(listener: (values: readonly T[]) => void): Unsubscribe;
}

export interface RegistryOptions<T> {
  /** Identity of an item: a later item with the same key replaces the earlier one. */
  readonly key?: (item: T) => string;
  /** Sort key, ascending. Equal orders keep insertion order. Default `0`. */
  readonly order?: (item: T) => number;
  /** Validate every added item; a mismatch throws `ContractViolationError` at the contributor. */
  readonly shape?: Shape<unknown>;
}

// ---------------------------------------------------------------------------
// Page-wide state shared with the loader (not part of the public surface)
// ---------------------------------------------------------------------------

/** Where the loader records the plugin being imported/activated. Read through {@link activatingPlugin}. */
const ACTIVATING = Symbol.for("ddd.kernel.activating-plugin");
/** Every registry on the page, so a failed plugin's items can be withdrawn from all of them. */
const REGISTRIES = Symbol.for("ddd.kernel.registries");

type Global = { [ACTIVATING]?: string; [REGISTRIES]?: Set<(pluginId: string) => void> };
const page = globalThis as unknown as Global;

const activatingPlugin = (): string | undefined => page[ACTIVATING];
const liveRegistries = (): Set<(pluginId: string) => void> => (page[REGISTRIES] ??= new Set());

/** The id convention's plugin part: `graph.view` → `graph`. */
function prefixOf(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const dot = key.indexOf(".");
  return dot > 0 ? key.slice(0, dot) : undefined;
}

function idOf(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const id = (item as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

interface Slot<T> {
  readonly token: number;
  readonly value: T;
  readonly pluginId: string;
  readonly key: string | undefined;
  readonly order: number;
}

export function createRegistry<T>(options: RegistryOptions<T> = {}): Registry<T> {
  let slots: Slot<T>[] = [];
  let next = 0;
  let values: readonly T[] = Object.freeze([]);
  let entries: readonly RegistryEntry<T>[] = Object.freeze([]);
  const listeners = new Set<(values: readonly T[]) => void>();

  const publish = (): void => {
    slots = [...slots].sort((a, b) => a.order - b.order || a.token - b.token);
    entries = Object.freeze(slots.map((slot) => Object.freeze({ value: slot.value, pluginId: slot.pluginId })));
    values = Object.freeze(slots.map((slot) => slot.value));
    for (const listener of [...listeners]) {
      try {
        listener(values);
      } catch (error) {
        console.warn("[registry] a listener threw", error);
      }
    }
  };

  const remove = (tokens: ReadonlySet<number>): void => {
    const before = slots.length;
    slots = slots.filter((slot) => !tokens.has(slot.token));
    if (slots.length !== before) publish();
  };

  // A failed plugin's contributions go with it (the loader's `retract`).
  liveRegistries().add((pluginId) => {
    const tokens = new Set(slots.filter((slot) => slot.pluginId === pluginId).map((slot) => slot.token));
    if (tokens.size > 0) remove(tokens);
  });

  return {
    add(input) {
      const items: readonly T[] = Array.isArray(input) ? (input as readonly T[]) : [input as T];
      const activating = activatingPlugin();
      const added: Slot<T>[] = [];
      for (const item of items) {
        if (options.shape) {
          const issues = options.shape.check(item, "");
          if (issues.length > 0) {
            throw new ContractViolationError(`registry item rejected: ${formatIssues(issues)}`, {
              ...(activating ? { pluginId: activating } : {}),
            });
          }
        }
        const key = options.key?.(item);
        added.push({
          token: next++,
          value: item,
          key,
          order: options.order?.(item) ?? 0,
          pluginId: activating ?? prefixOf(key ?? idOf(item)) ?? "unknown",
        });
      }
      const keys = new Set(added.map((slot) => slot.key).filter((key): key is string => key !== undefined));
      // Later wins, within one call as across calls.
      const deduped = added.filter((slot, index) => slot.key === undefined || !added.slice(index + 1).some((later) => later.key === slot.key));
      slots = [...slots.filter((slot) => slot.key === undefined || !keys.has(slot.key)), ...deduped];
      publish();
      const tokens = new Set(deduped.map((slot) => slot.token));
      let done = false;
      return () => {
        if (done) return;
        done = true;
        remove(tokens);
      };
    },
    get: () => values,
    entries: () => entries,
    subscribe(listener) {
      listeners.add(listener);
      listener(values);
      return () => void listeners.delete(listener);
    },
  };
}

// ---------------------------------------------------------------------------
// checked
// ---------------------------------------------------------------------------

/**
 * Wrap an exported function so its arguments — and its result, when the shape names one —
 * are validated on every call. A mismatch throws `ContractViolationError` naming the
 * function and the path; a promised result is checked when it settles.
 *
 * ```ts
 * export const open = checked(s.fn([s.string()], s.promise(s.boolean())), async (id: string) => …);
 * ```
 *
 * Validation is opt-in: the types a plugin exports are the contract, and this is for a
 * function other plugins call with data that did not come from the compiler.
 */
export function checked<F extends (...args: never[]) => unknown>(shape: Shape<unknown>, impl: F): F {
  const parts = (shape as Partial<BuiltShape<unknown>>).parts;
  const args = parts?.args ?? [];
  const returns = parts?.returns;
  const name = impl.name || "function";
  const fail = (where: string, issues: ReturnType<Shape<unknown>["check"]>): never => {
    throw new ContractViolationError(`${name}: ${where}: ${formatIssues(issues)}`);
  };
  const checkResult = (result: unknown): unknown => {
    if (!returns) return result;
    const issues = returns.check(result, "");
    if (issues.length > 0) fail("result", issues);
    const inner = returns.name === "promise" ? returns.parts?.item : undefined;
    if (inner && result !== null && typeof (result as { then?: unknown }).then === "function") {
      return (result as Promise<unknown>).then((value) => {
        const resolved = inner.check(value, "");
        if (resolved.length > 0) fail("resolved value", resolved);
        return value;
      });
    }
    return result;
  };
  const wrapped = function (this: unknown, ...values: unknown[]): unknown {
    args.forEach((arg, index) => {
      const issues = arg.check(values[index], "");
      if (issues.length > 0) fail(`argument ${index + 1}`, issues);
    });
    return checkResult((impl as unknown as (...a: unknown[]) => unknown).apply(this, values));
  };
  Object.defineProperty(wrapped, "name", { value: name });
  return wrapped as unknown as F;
}
