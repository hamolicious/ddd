import { CloseCode, PROTOCOL_VERSION, type ServerControl, type Welcome } from "../protocol.js";
import type { ProjectionStore } from "../store/projection-store.js";
import { BackoffState } from "./backoff.js";
import { BootstrapClient, type BootstrapOptions } from "./bootstrap.js";
import { FeedClient, type FeedState, type SyncStatus } from "./feed-client.js";
import { DocHydrator, type DocHydratorOptions, type HydratedDoc } from "./doc-hydration.js";
import { SyncTransport, type TransportOptions } from "./transport.js";

export const RECONNECT_NOW_THROTTLE_MS = 5_000;

export const MAX_PROTOCOL_ERROR_RETRIES = 2;

export interface SyncClientOptions {
  readonly transport?: TransportOptions;
  readonly bootstrap?: BootstrapOptions;
  readonly hydrator?: DocHydratorOptions;
  readonly includeContent?: boolean;
  readonly onState?: (state: FeedState) => void;
  readonly autoReconnect?: boolean;
  readonly authProbe?: () => Promise<"ok" | "unauthenticated" | "unreachable">;
  readonly onConnected?: () => void;
  readonly onPluginsChanged?: (version: number | string) => void;
  readonly pluginsVersion?: number | string;
  readonly setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
}

export class SyncClient {
  readonly transport: SyncTransport;
  readonly feed: FeedClient;
  readonly docs: DocHydrator;
  readonly #backoff = new BackoffState();
  #welcome: Welcome | undefined;
  #stopped = true;
  #welcomeSeen = false;
  #queue: Promise<void> = Promise.resolve();
  #reconnectPending = false;
  #lastReconnectNow = 0;
  #protocolErrors = 0;
  #transportError: string | undefined;
  #attemptOpened = false;
  #state: FeedState = { status: "offline", safeSeq: 0, headSeq: 0, pending: 0 };
  #unsubscribeStore: (() => void) | undefined;
  #pluginsVersion: number | string | undefined;
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
    this.#unsubscribeStore = store.subscribe((change) => {
      if (change.purged.length > 0) void this.docs.dropReplicas(change.purged);
    });
  }

  get status(): SyncStatus {
    return this.feed.state.status;
  }

  get state(): FeedState {
    return this.#state;
  }

  get pending(): number {
    return this.docs.pendingCount;
  }

  get autoReconnect(): boolean {
    return this.options.autoReconnect ?? true;
  }

  get welcome(): Welcome | undefined {
    return this.#welcome;
  }

  async start(): Promise<void> {
    this.#stopped = false;
    this.#unsubscribeStore ??= this.store.subscribe((change) => {
      if (change.purged.length > 0) void this.docs.dropReplicas(change.purged);
    });
    await this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribeStore?.();
    this.#unsubscribeStore = undefined;
    this.docs.releaseAll();
    this.transport.close(CloseCode.Normal, "client stopped");
  }

  open(id: string): Promise<HydratedDoc> {
    return this.docs.open(id);
  }

  reconnectNow(): void {
    const now = Date.now();
    if (this.#stopped) return;
    if (this.transport.state !== "closed") return;
    if (this.feed.state.status !== "auth-required" && now - this.#lastReconnectNow < RECONNECT_NOW_THROTTLE_MS) return;
    this.#lastReconnectNow = now;
    this.#reconnectPending = false;
    this.#protocolErrors = 0;
    void this.#connect();
  }

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
      this.transport.close(CloseCode.ProtocolError, "welcome expected first");
      return;
    }
    switch (message.t) {
      case "welcome": {
        if (message.protocol !== PROTOCOL_VERSION) {
          this.transport.close(CloseCode.UnsupportedVersion, "unsupported protocol version");
          return;
        }
        this.#welcomeSeen = true;
        this.#welcome = message;
        this.#transportError = undefined;
        this.transport.applyHeartbeatSeconds(message.limits.heartbeat_secs);
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
    if (delay === undefined) return;
    if (status === "offline" && !this.#attemptOpened) {
      this.#retryOrAskToSignIn(delay);
      return;
    }
    this.#scheduleReconnect(delay);
  }

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

  get internals(): { readonly backoff: BackoffState; readonly stopped: boolean } {
    return { backoff: this.#backoff, stopped: this.#stopped };
  }
}
