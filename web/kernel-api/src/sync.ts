/**
 * `kernel.sync` — the observable status of SPEC §6.4, and nothing more.
 *
 * It is a *read* surface. Plugins do not drive sync: there is no "sync now", no
 * "subscribe to this document" (that is `documents.open`), and no way to reach the
 * socket. The one imperative is {@link SyncApi.reconnectNow}, which exists because
 * the kernel has no DOM and cannot watch `navigator.onLine` itself.
 *
 * **FROZEN.**
 */

import type { Unsubscribe } from "./types.js";

export type SyncStatus =
  | "offline"
  | "connecting"
  | "syncing"
  | "synced"
  | "auth-required"
  | "error";

/** Progress of a bootstrap pass (cold start or `feed.reset`). */
export interface BootstrapProgress {
  readonly rows: number;
  readonly total?: number;
  readonly complete: boolean;
}

export interface SyncState {
  readonly status: SyncStatus;
  /** The persisted resume point — the server's `safe_seq`, never `max(seq)` seen. */
  readonly safeSeq: number;
  /** Server head, for "N changes behind". */
  readonly headSeq: number;
  /** Local edits the socket has not carried yet. */
  readonly pending: number;
  readonly bootstrap?: BootstrapProgress;
  readonly lastError?: string;
}

export interface SyncApi {
  readonly state: SyncState;
  /** Fires immediately with the current state, then on every transition. */
  subscribe(listener: (state: SyncState) => void): Unsubscribe;
  /**
   * Reconnect now, ignoring the backoff. Throttled internally, and a no-op while
   * a socket is up — safe to call from an `online` handler, a visibility change,
   * or a "retry" button.
   */
  reconnectNow(): void;
}
