import type { Unsubscribe } from "./types.js";

export const KERNEL_EVENT_PREFIX = "kernel:";

export const KernelEvents = {
  pluginFailed: "kernel:plugin-failed",
  updateAvailable: "kernel:update-available",
  syncChanged: "kernel:sync-changed",
  authRequired: "kernel:auth-required",
  storageWarning: "kernel:storage-warning",
} as const;

export type KernelEventName = (typeof KernelEvents)[keyof typeof KernelEvents];

export type EventOrigin =
  | { readonly kind: "kernel" }
  | { readonly kind: "plugin"; readonly id: string }
  | { readonly kind: "server"; readonly plugin: string };

export interface KernelEvent<P = unknown> {
  readonly type: string;
  readonly payload: P;
  readonly origin: EventOrigin;
  readonly at: number;
}

export interface EventsApi {
  emit<P>(type: string, payload?: P): void;
  on<P>(type: string, listener: (event: KernelEvent<P>) => void): Unsubscribe;
  once<P>(type: string, listener: (event: KernelEvent<P>) => void): Unsubscribe;
  onAny(listener: (event: KernelEvent) => void): Unsubscribe;
}
