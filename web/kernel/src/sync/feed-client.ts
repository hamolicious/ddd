import {
  DEFAULT_BATCH_MAX_ROWS,
  type FeedBatch,
  type FeedReset,
  type FeedResync,
  type Welcome,
} from "../protocol.js";
import { EMPTY_CHECKPOINT, type ProjectionStore, type SyncCheckpoint } from "../store/projection-store.js";
import { BootstrapHttpError, type BootstrapClient, type BootstrapProgress } from "./bootstrap.js";
import type { SyncTransport } from "./transport.js";

export const MAX_BOOTSTRAP_ATTEMPTS_PER_CONNECTION = 3;

export type SyncStatus =
  | "offline"
  | "connecting"
  | "syncing"
  | "synced"
  | "auth-required"
  | "error";

export interface FeedState {
  readonly status: SyncStatus;
  readonly safeSeq: number;
  readonly headSeq: number;
  readonly bootstrap?: BootstrapProgress;
  readonly lastError?: string;
  readonly pending?: number;
}

export interface FeedClientOptions {
  readonly includeContent?: boolean;
  readonly batchMaxRows?: number;
  readonly onState?: (state: FeedState) => void;
}

export class FeedClient {
  #state: FeedState = { status: "offline", safeSeq: 0, headSeq: 0 };
  #checkpoint: SyncCheckpoint = EMPTY_CHECKPOINT;
  #coreSemanticsVersion: number | null = null;
  #subscribedSince: number | undefined;
  #bootstrapAttempts = 0;

  constructor(
    private readonly transport: SyncTransport,
    private readonly store: ProjectionStore,
    private readonly bootstrap: BootstrapClient,
    private readonly options: FeedClientOptions = {},
  ) {}

  get state(): FeedState {
    return this.#state;
  }

  async start(welcome: Welcome): Promise<void> {
    this.#bootstrapAttempts = 0;
    this.#coreSemanticsVersion = welcome.core_semantics_version;
    this.#checkpoint = await this.store.checkpoint();
    this.#setState({
      status: "syncing",
      safeSeq: this.#checkpoint.safeSeq,
      headSeq: welcome.feed.head_seq,
      lastError: undefined,
    });

    const mustBootstrap =
      !this.#checkpoint.bootstrapped || welcome.feed.floor_seq > this.#checkpoint.safeSeq;
    if (mustBootstrap) {
      await this.#runBootstrap();
      return;
    }
    this.subscribe(this.#checkpoint.safeSeq);
  }

  subscribe(sinceSeq: number): void {
    this.#subscribedSince = sinceSeq;
    this.transport.sendControl({
      t: "feed.subscribe",
      since_seq: sinceSeq,
      include_content: this.options.includeContent ?? true,
      batch_max_rows: this.options.batchMaxRows ?? DEFAULT_BATCH_MAX_ROWS,
    });
  }

  unsubscribe(): void {
    this.transport.sendControl({ t: "feed.unsubscribe" });
  }

  async onBatch(batch: FeedBatch): Promise<void> {
    const bootstrapped =
      this.#checkpoint.bootstrapped || (batch.complete && this.#subscribedSince === 0);

    const checkpoint: SyncCheckpoint = {
      safeSeq: batch.safe_seq,
      updatedAt: Date.now(),
      coreSemanticsVersion: this.#coreSemanticsVersion ?? this.#checkpoint.coreSemanticsVersion,
      bootstrapped,
    };
    await this.store.applyRows(batch.rows, checkpoint);
    this.#checkpoint = {
      ...checkpoint,
      safeSeq: Math.max(checkpoint.safeSeq, this.#checkpoint.safeSeq),
    };

    this.#setState({
      status: batch.complete || batch.mode === "live" ? "synced" : "syncing",
      safeSeq: this.#checkpoint.safeSeq,
      headSeq: batch.head_seq,
      bootstrap: undefined,
    });
  }

  async onReset(reset: FeedReset): Promise<void> {
    this.#setState({
      status: "syncing",
      lastError: `feed.reset: ${reset.reason}`,
      headSeq: reset.head_seq,
    });
    await this.#runBootstrap();
  }

  onResync(resync: FeedResync): void {
    this.subscribe(resync.from_seq);
  }

  onConnecting(): void {
    this.#setState({ status: "connecting", lastError: undefined });
  }

  onDisconnected(status: Extract<SyncStatus, "offline" | "auth-required" | "error">): void {
    this.#subscribedSince = undefined;
    this.#setState({ status, bootstrap: undefined });
  }

  get caughtUp(): boolean {
    return this.#state.status === "synced";
  }

  get projection(): ProjectionStore {
    return this.store;
  }

  get bootstrapClient(): BootstrapClient {
    return this.bootstrap;
  }

  async #runBootstrap(): Promise<void> {
    if (this.#bootstrapAttempts >= MAX_BOOTSTRAP_ATTEMPTS_PER_CONNECTION) {
      this.#setState({
        status: "error",
        lastError: `bootstrap failed ${this.#bootstrapAttempts}× on this connection`,
        bootstrap: undefined,
      });
      return;
    }
    this.#bootstrapAttempts++;
    this.#setState({
      status: "syncing",
      bootstrap: { rows: 0, total: 0, safeSeq: 0, complete: false },
    });
    try {
      const result = await this.bootstrap.run((progress) =>
        this.#setState({ bootstrap: progress }),
      );
      this.#checkpoint = await this.store.checkpoint();
      this.#setState({ safeSeq: result.safeSeq, bootstrap: undefined });
      if (this.transport.state !== "open") {
        this.#setState({ status: "offline" });
        return;
      }
      this.subscribe(result.safeSeq);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof BootstrapHttpError && cause.status === 401) {
        this.#setState({ status: "auth-required", lastError: message, bootstrap: undefined });
        return;
      }
      this.#setState({ status: "error", lastError: message, bootstrap: undefined });
    }
  }

  #setState(patch: Partial<FeedState>): void {
    this.#state = { ...this.#state, ...patch };
    this.options.onState?.(this.#state);
  }
}
