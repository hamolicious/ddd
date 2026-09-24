/**
 * `kernel.events` — the in-page bus, plus the delivery point for server-pushed
 * plugin events.
 *
 * **Documents first.** SPEC §1 is explicit: when two halves of a plugin need to
 * share state, the backend writes *documents* and sync carries them everywhere,
 * offline included. Events are for what genuinely cannot be a document —
 * "the palette opened", "re-render now", a backend `emit_client` ping.
 *
 * Consequences, stated so nobody designs around the wrong one:
 *
 * - Events are **ephemeral and fire-and-forget**. No replay, no offline queue, no
 *   delivery guarantee. A client that was closed missed it (SPEC §6.3).
 * - `type` is a free string; the convention is `"<plugin-id>:<event>"`. The kernel
 *   reserves the `kernel:` prefix and rejects an `emit` using it.
 *
 * **FROZEN.**
 */

import type { Unsubscribe } from "./types.js";

/** Reserved prefix: only the kernel emits these. */
export const KERNEL_EVENT_PREFIX = "kernel:";

/** Events the kernel itself emits. Names are frozen; the payloads are below. */
export const KernelEvents = {
  /** A plugin failed to activate, or its contribution threw while rendering. */
  pluginFailed: "kernel:plugin-failed",
  /** A new app bundle or plugin version is available (one reload covers both). */
  updateAvailable: "kernel:update-available",
  /** Sync status changed — the same state `kernel.sync.subscribe` reports. */
  syncChanged: "kernel:sync-changed",
  /** The session needs re-authentication (close code 4401). Local data is intact. */
  authRequired: "kernel:auth-required",
  /** Storage is under pressure or persistence was denied (SPEC §6.4). */
  storageWarning: "kernel:storage-warning",
} as const;

export type KernelEventName = (typeof KernelEvents)[keyof typeof KernelEvents];

export type EventOrigin =
  | { readonly kind: "kernel" }
  | { readonly kind: "plugin"; readonly id: string }
  /** Relayed from a backend plugin half over the socket (M4 `emit_client`). */
  | { readonly kind: "server"; readonly plugin: string };

export interface KernelEvent<P = unknown> {
  readonly type: string;
  readonly payload: P;
  readonly origin: EventOrigin;
  /** `Date.now()` at emit. Never used for ordering (SPEC: order is `seq`). */
  readonly at: number;
}

export interface EventsApi {
  /** Emit locally. Throws on the reserved `kernel:` prefix. */
  emit<P>(type: string, payload?: P): void;
  on<P>(type: string, listener: (event: KernelEvent<P>) => void): Unsubscribe;
  once<P>(type: string, listener: (event: KernelEvent<P>) => void): Unsubscribe;
  /** Every event, for debug panels. Do not build features on it. */
  onAny(listener: (event: KernelEvent) => void): Unsubscribe;
}
