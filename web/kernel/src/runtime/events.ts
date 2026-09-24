/**
 * The event bus. Synchronous, in-page, ephemeral — see the contract in
 * `kernel-api/src/events.ts` for why it is deliberately the *second* choice after
 * documents.
 *
 * A listener that throws must not stop delivery to the others: plugins are
 * unsandboxed (SPEC §6.1) and one bad subscriber taking the bus down would take
 * the app with it. Throws are reported and swallowed.
 */

import {
  KERNEL_EVENT_PREFIX,
  ContractViolationError,
  type EventOrigin,
  type EventsApi,
  type KernelEvent,
  type Unsubscribe,
} from "@kernel";

type Listener = (event: KernelEvent) => void;

export class EventBus {
  readonly #byType = new Map<string, Set<Listener>>();
  readonly #any = new Set<Listener>();

  constructor(private readonly onListenerError?: (type: string, error: unknown) => void) {}

  /** Emit as the kernel — the only origin allowed to use the reserved prefix. */
  emitKernel<P>(type: string, payload?: P): void {
    this.#dispatch(type, payload, { kind: "kernel" });
  }

  /** Emit as a backend plugin half relaying through the socket (M4). */
  emitFromServer<P>(pluginId: string, type: string, payload?: P): void {
    this.#dispatch(type, payload, { kind: "server", plugin: pluginId });
  }

  on(type: string, listener: Listener): Unsubscribe {
    const set = this.#byType.get(type) ?? new Set<Listener>();
    this.#byType.set(type, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#byType.delete(type);
    };
  }

  forPlugin(pluginId: string): EventsApi {
    return {
      emit: <P>(type: string, payload?: P) => {
        if (type.startsWith(KERNEL_EVENT_PREFIX)) {
          throw new ContractViolationError(
            `"${pluginId}" may not emit "${type}": the "${KERNEL_EVENT_PREFIX}" prefix is the kernel's`,
            { pluginId, type },
          );
        }
        this.#dispatch(type, payload, { kind: "plugin", id: pluginId });
      },
      on: <P>(type: string, listener: (event: KernelEvent<P>) => void) =>
        this.on(type, listener as Listener),
      once: <P>(type: string, listener: (event: KernelEvent<P>) => void) => {
        const stop = this.on(type, (event) => {
          stop();
          (listener as Listener)(event);
        });
        return stop;
      },
      onAny: (listener) => {
        this.#any.add(listener as Listener);
        return () => this.#any.delete(listener as Listener);
      },
    };
  }

  #dispatch<P>(type: string, payload: P | undefined, origin: EventOrigin): void {
    const event: KernelEvent<P> = {
      type,
      payload: payload as P,
      origin,
      at: Date.now(),
    };
    for (const listener of [...(this.#byType.get(type) ?? [])]) this.#safely(type, listener, event);
    for (const listener of [...this.#any]) this.#safely(type, listener, event);
  }

  #safely(type: string, listener: Listener, event: KernelEvent<unknown>): void {
    try {
      listener(event);
    } catch (error) {
      if (this.onListenerError) this.onListenerError(type, error);
      else console.warn(`[events] listener for "${type}" threw`, error);
    }
  }
}
