/**
 * `kernel.sync` over the M2 `SyncClient`. A read surface and a throttled
 * "reconnect now", nothing else — the reasoning is in `kernel-api/src/sync.ts`.
 *
 * The kernel has no DOM (a rule M2 established and M3 keeps for everything below
 * `runtime/`), so the *app* listens for `online`/`visibilitychange` and calls
 * `reconnectNow`; this class only forwards.
 */

import type { SyncApi, SyncState, Unsubscribe } from "@kernel";

import type { FeedState } from "../sync/feed-client.js";
import type { SyncClient } from "../sync/client.js";

export class SyncHost {
  readonly #listeners = new Set<(state: SyncState) => void>();
  #state: SyncState;

  constructor(private readonly client: SyncClient) {
    this.#state = project(client.state);
  }

  /** Called by the app from `SyncClientOptions.onState`. */
  update(state: FeedState): void {
    this.#state = project(state);
    for (const listener of [...this.#listeners]) listener(this.#state);
  }

  get state(): SyncState {
    return this.#state;
  }

  api(): SyncApi {
    const host = this;
    return {
      get state(): SyncState {
        return host.#state;
      },
      subscribe: (listener): Unsubscribe => {
        host.#listeners.add(listener);
        listener(host.#state);
        return () => host.#listeners.delete(listener);
      },
      reconnectNow: () => host.client.reconnectNow(),
    };
  }
}

/** `FeedState` has `pending?`; the contract promises a number. */
function project(state: FeedState): SyncState {
  return {
    status: state.status,
    safeSeq: state.safeSeq,
    headSeq: state.headSeq,
    pending: state.pending ?? 0,
    ...(state.bootstrap ? { bootstrap: state.bootstrap } : {}),
    ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
  };
}
