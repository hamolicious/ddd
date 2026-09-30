/**
 * `SyncClient` — the façade M3's `@kernel.sync` and `@kernel.documents` are built
 * on, and what the demo page and harness drive.
 *
 * It owns the reconnect loop and the routing table, and nothing else: control
 * messages go to the feed client, binary frames to the hydrator, close codes to
 * the backoff state machine.
 *
 * Two routing rules are worth stating out loud:
 *
 * - **Control messages are handled in arrival order, one at a time.** Feed
 *   batches must be applied in `seq` order, and `onBatch` awaits IndexedDB — so
 *   they go through a promise chain rather than straight off the socket callback.
 * - **Binary frames are not queued.** They are independent of feed ordering, and
 *   an editor keystroke must not wait behind a bootstrap pass.
 *
 * **FROZEN INTERFACE.**
 */

import { CloseCode, PROTOCOL_VERSION, type ServerControl, type Welcome } from "../protocol.js";
import type { ProjectionStore } from "../store/projection-store.js";
import { BackoffState } from "./backoff.js";
import { BootstrapClient, type BootstrapOptions } from "./bootstrap.js";
import { FeedClient, type FeedState, type SyncStatus } from "./feed-client.js";
import { DocHydrator, type DocHydratorOptions, type HydratedDoc } from "./doc-hydration.js";
import { SyncTransport, type TransportOptions } from "./transport.js";

/**
 * Minimum gap between the "reconnect right now" triggers of PROTOCOL.md §8
 * (`navigator.onLine`, tab visibility). The kernel never listens for those
 * itself — it has no DOM — so the shell calls {@link SyncClient.reconnectNow}.
 */
export const RECONNECT_NOW_THROTTLE_MS = 5_000;

/**
 * Consecutive `4400` closes before the loop gives up. A protocol error is almost
 * always version skew (PROTOCOL.md §7): retrying forever would hammer the server
 * with a client it cannot talk to, so the third one stops and asks for a reload.
 */
export const MAX_PROTOCOL_ERROR_RETRIES = 2;

export interface SyncClientOptions {
  readonly transport?: TransportOptions;
  readonly bootstrap?: BootstrapOptions;
  readonly hydrator?: DocHydratorOptions;
  readonly includeContent?: boolean;
  readonly onState?: (state: FeedState) => void;
  /** `true` (default) reconnects with the PROTOCOL.md §8 backoff. */
  readonly autoReconnect?: boolean;
  /**
   * Asks the server, over plain HTTP, whether this session is still valid. Used when a
   * connection attempt fails without ever opening: a refused upgrade (HTTP 401) looks
   * exactly like a network failure to a browser, and without asking, a session that
   * ended while the device was offline read as "offline" forever.
   */
  readonly authProbe?: () => Promise<"ok" | "unauthenticated" | "unreachable">;
  /**
   * A connection is up and its feed has started: the moment to send what waited
   * offline (queued creates and trashes, then unsent edits in notes that are closed).
   */
  readonly onConnected?: () => void;
  /**
   * The plugin set changed on the server (`plugins.changed`, or a `welcome` whose
   * `plugins_version` differs from the one this page booted with). Default: reload the
   * page — there is no hot reload (`@kernel` 3.0). The first version seen is the booted
   * one unless {@link pluginsVersion} names it.
   */
  readonly onPluginsChanged?: (version: number | string) => void;
  /** The plugin-set version this page booted with, when the plugin list said. */
  readonly pluginsVersion?: number | string;
  /** Injectable clock for tests: schedules the reconnect attempt. */
  readonly setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
}

export class SyncClient {
  readonly transport: SyncTransport;
  readonly feed: FeedClient;
  readonly docs: DocHydrator;
  readonly #backoff = new BackoffState();
  #welcome: Welcome | undefined;
  #stopped = true;
  /** `welcome` must be the first frame of a connection (PROTOCOL.md §1.4). */
  #welcomeSeen = false;
  /** Serializes control-message handling so feed batches stay in order. */
  #queue: Promise<void> = Promise.resolve();
  #reconnectPending = false;
  #lastReconnectNow = 0;
  /** Consecutive `4400` closes (PROTOCOL.md §7). */
  #protocolErrors = 0;
  #transportError: string | undefined;
  /** The current connection attempt reached `open` (reset at each attempt). */
  #attemptOpened = false;
  #state: FeedState = { status: "offline", safeSeq: 0, headSeq: 0, pending: 0 };
  #unsubscribeStore: (() => void) | undefined;
  /** The plugin-set version this page runs; `undefined` until the list or a `welcome` says. */
  #pluginsVersion: number | string | undefined;
  /** A change was reported once; later frames wait for the reload rather than repeat it. */
  #pluginsChangeReported = false;

  constructor(
    readonly store: ProjectionStore,
    private readonly options: SyncClientOptions = {},
  ) {
    this.#pluginsVersion = options.pluginsVersion;
    this.transport = new SyncTransport(options.transport, {
      onControl: (message) => this.#enqueue(message),
      onBinary: (frame) => this.docs.onBinary(frame),
      onClose: (code, reason) => this.#onClose(code, reason),
      onError: (error) => this.#onError(error),
    });
    const bootstrap = new BootstrapClient(store, options.bootstrap);
    this.feed = new FeedClient(this.transport, store, bootstrap, {
      includeContent: options.includeContent ?? true,
      onState: (state) => this.#publish(state),
    });
    this.docs = new DocHydrator(this.transport, {
      ...options.hydrator,
      bearerToken: options.hydrator?.bearerToken ?? options.transport?.bearerToken,
      onPending: (pending) => {
        options.hydrator?.onPending?.(pending);
        this.#publish(this.feed.state);
      },
    });
    // A purge in the feed is the one thing that deletes a local replica
    // (PROTOCOL.md §2.1). The store reports it after the rows commit; the
    // hydrator offers recovery for unsynced edits before discarding.
    this.#unsubscribeStore = store.subscribe((change) => {
      if (change.purged.length > 0) void this.docs.dropReplicas(change.purged);
    });
  }

  get status(): SyncStatus {
    return this.feed.state.status;
  }

  /**
   * The full sync status observable of SPEC §6.4: the feed's state plus the
   * client-side pending-write count.
   */
  get state(): FeedState {
    return this.#state;
  }

  /** Local edits waiting for the socket. */
  get pending(): number {
    return this.docs.pendingCount;
  }

  /** Whether the reconnect loop runs (PROTOCOL.md §8). */
  get autoReconnect(): boolean {
    return this.options.autoReconnect ?? true;
  }

  /** The `welcome` of the current connection, or `undefined` when offline. */
  get welcome(): Welcome | undefined {
    return this.#welcome;
  }

  /**
   * Connect, run the feed, and keep reconnecting until `stop()`.
   *
   * Resolves once the first attempt has settled — open, or scheduled for a
   * retry. It does not wait for catch-up: the store is readable immediately,
   * which is the whole point of an offline-first client.
   */
  async start(): Promise<void> {
    this.#stopped = false;
    // `stop()` drops the store subscription; starting again restores it, so a
    // stop/start cycle does not silently lose purge notifications.
    this.#unsubscribeStore ??= this.store.subscribe((change) => {
      if (change.purged.length > 0) void this.docs.dropReplicas(change.purged);
    });
    await this.#connect();
  }

  /** Stop the reconnect loop and close the socket. Local data is untouched. */
  stop(): void {
    this.#stopped = true;
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = undefined;
    this.docs.releaseAll();
    this.transport.close(CloseCode.Normal, "client stopped");
  }

  /** Open a document for editing (SPEC §4.1 lazy hydration). */
  open(id: string): Promise<HydratedDoc> {
    return this.docs.open(id);
  }

  /**
   * Reconnect immediately, ignoring the backoff — the shell calls this when
   * `navigator.onLine` flips true or the tab becomes visible, and after a
   * successful re-login following a `4401` (PROTOCOL.md §8). Throttled, and a
   * no-op while a socket is already up.
   */
  // INTEGRATION (web-demo / M5 shell): the kernel has no DOM, so nothing here
  // listens for `online` or `visibilitychange`. The page that owns the DOM should
  // call `reconnectNow()` on both, and after a successful re-login following a
  // `4401` — the throttle inside makes double-calling harmless.
  reconnectNow(): void {
    const now = Date.now();
    if (this.#stopped) return;
    if (this.transport.state !== "closed") return;
    // Not while signed out: the call after a successful sign-in is the only way out of
    // `auth-required`, and throttling it (a Reconnect click moments before) left the
    // sign-in dialog up for good.
    if (this.feed.state.status !== "auth-required" && now - this.#lastReconnectNow < RECONNECT_NOW_THROTTLE_MS) return;
    this.#lastReconnectNow = now;
    this.#reconnectPending = false;
    // An explicit user action clears the skew counter: a reload or a re-login is
    // exactly the thing that might have fixed it.
    this.#protocolErrors = 0;
    void this.#connect();
  }

  /** Control messages, one at a time, in arrival order. */
  /**
   * A plugin-set version from the server. The first one is the booted version (unless the
   * plugin list named it); a different one means the plugin set changed and the page
   * reloads (`@kernel` 3.0: no hot reload).
   */
  #pluginsVersionSeen(version: number | string): void {
    if (this.#pluginsVersion === undefined) {
      this.#pluginsVersion = version;
      return;
    }
    if (version === this.#pluginsVersion || this.#pluginsChangeReported) return;
    this.#pluginsChangeReported = true;
    if (this.options.onPluginsChanged) this.options.onPluginsChanged(version);
    else globalThis.location?.reload();
  }

  #enqueue(message: ServerControl): void {
    this.#queue = this.#queue
      .then(() => this.#handle(message))
      .catch((cause: unknown) => {
        this.#transportError = cause instanceof Error ? cause.message : String(cause);
        this.#publish(this.feed.state);
      });
  }

  async #handle(message: ServerControl): Promise<void> {
    if (message.t !== "welcome" && !this.#welcomeSeen) {
      // PROTOCOL.md §1.4: anything before `welcome` is a protocol error.
      this.transport.close(CloseCode.ProtocolError, "welcome expected first");
      return;
    }
    switch (message.t) {
      case "welcome": {
        if (message.protocol !== PROTOCOL_VERSION) {
          // Stale bundle against a newer server (or the reverse): stop, prompt a
          // reload. The backoff treats 4409 as terminal.
          this.transport.close(CloseCode.UnsupportedVersion, "unsupported protocol version");
          return;
        }
        this.#welcomeSeen = true;
        this.#welcome = message;
        this.#transportError = undefined;
        // `#protocolErrors` is deliberately *not* reset here. A version-skewed
        // client gets a perfectly good `welcome` and then trips on the first frame
        // it does not understand — resetting on welcome would make the escalation
        // in `#onClose` unreachable in exactly the case it exists for. Only an
        // explicit `reconnectNow()` (reload, re-login) clears it.
        // INTEGRATION (wasm / M3 kernel façade): `core_semantics_version` is
        // recorded on the checkpoint by the feed client. Comparing it with the
        // local Wasm core's value — and surfacing "reload to update" while staying
        // read-only-trusting of the server's materialization (PROTOCOL.md §1.4) —
        // belongs to whoever owns `loadCore()` and the kernel surface, not here.
        this.transport.applyHeartbeatSeconds(message.limits.heartbeat_secs);
        // Documents first: an open editor resumes while the feed catches up.
        this.docs.resubscribeAll();
        await this.feed.start(message);
        this.options.onConnected?.();
        if (message.plugins_version !== undefined) this.#pluginsVersionSeen(message.plugins_version);
        return;
      }
      case "plugins.changed":
        this.#pluginsVersionSeen(message.version);
        return;
      case "feed.batch":
        await this.feed.onBatch(message);
        return;
      case "feed.reset":
        await this.feed.onReset(message);
        return;
      case "feed.resync":
        this.feed.onResync(message);
        return;
      case "doc.subscribed":
        this.docs.onSubscribed(message);
        return;
      case "doc.error":
        this.docs.onDocError(message);
        return;
      case "doc.resync":
        this.docs.onResync(message);
        return;
      case "pong":
        // The transport already cleared the liveness deadline.
        return;
      case "error": {
        this.#transportError = `${message.code}: ${message.message}`;
        if (message.fatal) this.feed.onDisconnected("error");
        else this.#publish(this.feed.state);
        return;
      }
    }
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    if (this.transport.state !== "closed") return;
    this.#welcomeSeen = false;
    this.#welcome = undefined;
    this.feed.onConnecting();
    this.#attemptOpened = false;
    try {
      await this.transport.connect();
      this.#attemptOpened = true;
      this.#backoff.markOpen();
    } catch {
      // `onClose` runs for a socket that closed before opening and has the close
      // code; a connect that never produced one lands here.
      if (this.feed.state.status !== "auth-required") this.feed.onDisconnected("offline");
      this.#retryOrAskToSignIn(undefined);
    }
  }

  #onClose(code: number, reason: string): void {
    const caughtUp = this.feed.caughtUp;
    this.#welcome = undefined;
    this.#welcomeSeen = false;
    this.docs.onDisconnected();
    if (reason) this.#transportError = `${code} ${reason}`;

    // 4401 is "re-authenticate", and nothing else: local data stays exactly where
    // it is (SPEC §5.3). 4403/4409 are misconfiguration or version skew — both
    // need a human, so they surface as `error`.
    // Repeated protocol errors are version skew, not bad luck: stop and say so
    // rather than reconnecting into the same wall.
    this.#protocolErrors = code === CloseCode.ProtocolError ? this.#protocolErrors + 1 : 0;
    const skewed = this.#protocolErrors > MAX_PROTOCOL_ERROR_RETRIES;
    if (skewed) this.#transportError = "protocol error repeated — reload to update";

    const status =
      code === CloseCode.Unauthenticated
        ? "auth-required"
        : skewed || code === CloseCode.OriginRefused || code === CloseCode.UnsupportedVersion
          ? "error"
          : "offline";
    this.feed.onDisconnected(status);
    this.#backoff.markClosed(caughtUp);

    if (this.#stopped || !this.autoReconnect || skewed) return;
    const delay = this.#backoff.nextDelay(code);
    // `undefined` ⇒ terminal (4401/4403/4409): only a user action restarts the
    // loop, via `reconnectNow()`.
    if (delay === undefined) return;
    if (status === "offline" && !this.#attemptOpened) {
      this.#retryOrAskToSignIn(delay);
      return;
    }
    this.#scheduleReconnect(delay);
  }

  /**
   * A connection attempt that never opened: offline, or a refused upgrade. Ask the
   * server which (when it can be asked at all) before trying again: a session that is
   * gone must ask the person to sign in, not retry into the same wall forever.
   */
  #retryOrAskToSignIn(delay: number | undefined): void {
    const probe = this.options.authProbe;
    if (!probe) {
      this.#scheduleReconnect(delay);
      return;
    }
    void probe()
      .catch(() => "unreachable" as const)
      .then((verdict) => {
        if (this.#stopped) return;
        if (verdict === "unauthenticated") {
          this.#transportError = "the session has ended; sign in again";
          this.feed.onDisconnected("auth-required");
          return;
        }
        this.#scheduleReconnect(delay);
      });
  }

  #onError(error: Error): void {
    // The transport closes the socket after reporting; `#onClose` drives the
    // reconnect. All this does is keep the reason visible in the status.
    this.#transportError = error.message;
    this.#publish(this.feed.state);
  }

  #scheduleReconnect(delay: number | undefined): void {
    if (this.#stopped || !this.autoReconnect || this.#reconnectPending) return;
    this.#reconnectPending = true;
    const schedule = this.options.setTimeoutImpl ?? ((cb, ms) => setTimeout(cb, ms));
    const handle = schedule(() => {
      this.#reconnectPending = false;
      void this.#connect();
    }, delay ?? this.#backoff.nextDelay() ?? 0);
    (handle as { unref?: () => void } | undefined)?.unref?.();
  }

  #publish(state: FeedState): void {
    this.#state = {
      ...state,
      pending: this.docs.pendingCount,
      ...(state.lastError === undefined && this.#transportError !== undefined
        ? { lastError: this.#transportError }
        : {}),
    };
    this.options.onState?.(this.#state);
  }

  /** Exposed so tests can assert the backoff/stop bookkeeping. */
  get internals(): { readonly backoff: BackoffState; readonly stopped: boolean } {
    return { backoff: this.#backoff, stopped: this.#stopped };
  }
}
