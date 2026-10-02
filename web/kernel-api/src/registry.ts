import { ContractViolationError } from "./errors.js";
import { formatIssues, type BuiltShape, type Shape } from "./shape.js";
import type { Unsubscribe } from "./types.js";

export interface RegistryEntry<T> {
  readonly value: T;
  readonly pluginId: string;
}

export interface Registry<T> {
  add(items: T | readonly T[]): () => void;
  get(): readonly T[];
  entries(): readonly RegistryEntry<T>[];
  subscribe(listener: (values: readonly T[]) => void): Unsubscribe;
}

export interface RegistryOptions<T> {
  readonly key?: (item: T) => string;
  readonly order?: (item: T) => number;
  readonly shape?: Shape<unknown>;
}

const ACTIVATING = Symbol.for("ddd.kernel.activating-plugin");
const REGISTRIES = Symbol.for("ddd.kernel.registries");

type Global = { [ACTIVATING]?: string; [REGISTRIES]?: Set<(pluginId: string) => void> };
const page = globalThis as unknown as Global;

const activatingPlugin = (): string | undefined => page[ACTIVATING];
const liveRegistries = (): Set<(pluginId: string) => void> => (page[REGISTRIES] ??= new Set());

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
