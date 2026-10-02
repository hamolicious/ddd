import type { Kernel, Unsubscribe } from "@kernel";

export interface DocumentCreated {
  readonly id: string;
  readonly parent?: string;
}

const listeners = new Set<(doc: DocumentCreated) => void>();
let warn: (message: string, error: unknown) => void = (message, error) => console.warn(`[doc-events] ${message}`, error);

export function onCreated(listener: (doc: DocumentCreated) => void): Unsubscribe {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyCreated(doc: DocumentCreated): void {
  for (const listener of [...listeners]) {
    try {
      listener(doc);
    } catch (error) {
      warn("a created listener threw", error);
    }
  }
}

export default function activate(kernel: Kernel): void {
  warn = (message, error) => kernel.log.warn(message, error);
}
