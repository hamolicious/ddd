/**
 * The change-feed client (PROTOCOL.md §2, SPEC §4.1).
 *
 * Owns exactly one concern: keeping the local projection store equal to the
 * server's, and saying out loud where it is in that process. It does not know
 * about documents, CRDTs, or the DOM.
 *
 * Invariants a builder must not break:
 * 1. The persisted watermark is the server's `safe_seq`, never `max(seq)` seen.
 * 2. Rows and watermark are written in one store transaction (`applyRows`).
 * 3. `feed.reset` ⇒ bootstrap, and the store is **not** cleared first.
 * 4. `feed.resync` ⇒ re-subscribe at `from_seq`, keeping every local row.
 *
 * **FROZEN INTERFACE.**
 */

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

/**
 * How many bootstrap passes one connection may attempt before the client gives
 * up and reports `error`. Without a ceiling, a server that keeps answering
 * `feed.reset` and a bootstrap that keeps failing become an infinite loop that
 * hammers a single-replica server (SPEC §8).
 */
export const MAX_BOOTSTRAP_ATTEMPTS_PER_CONNECTION = 3;

/** What the kernel exposes as `@kernel.sync.status` (SPEC §6.4). */
export type SyncStatus =
  | "offline"
  | "connecting"
  | "syncing"
  | "synced"
  | "auth-required"
  | "error";

export interface FeedState {
  readonly status: SyncStatus;
  /** Persisted resume point. */
  readonly safeSeq: number;
  /** Server head, for "N changes behind" displays. */
  readonly headSeq: number;
  /** Set while a bootstrap pass is running. */
  readonly bootstrap?: BootstrapProgress;
  readonly lastError?: string;
  /**
   * Local edits not yet acknowledged by the socket — the outbox depth, not a
   * socket property (SPEC §6.4, PROTOCOL.md §8). The feed client never sets it;
   * `SyncClient` merges it in from the hydrator before publishing state.
   */
  readonly pending?: number;
}

export interface FeedClientOptions {
  readonly includeContent?: boolean;
  readonly batchMaxRows?: number;
  /** Called on every state transition; the UI subscribes here. */
  readonly onState?: (state: FeedState) => void;
}

export class FeedClient {
  #state: FeedState = { status: "offline", safeSeq: 0, headSeq: 0 };
  /** Mirror of the persisted checkpoint, so every write keeps its flags. */
  #checkpoint: SyncCheckpoint = EMPTY_CHECKPOINT;
  /** `welcome.core_semantics_version`: stamped onto the rows it materialized. */
  #coreSemanticsVersion: number | null = null;
  /** `since_seq` of the live subscription — `0` means "this is a full pass". */
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

  /**
   * Called by the sync client when `welcome` arrives: records the server's feed
   * position and subscribes from the persisted watermark.
   */
  async start(welcome: Welcome): Promise<void> {
    this.#bootstrapAttempts = 0;
    // INTEGRATION (wasm): the server's value is recorded on the checkpoint with
    // every batch, so a client whose Wasm core disagrees can tell that its local
    // parse of `content` is not the one that produced these rows (PROTOCOL.md
    // §1.4). Acting on the mismatch — "reload to update", read-only trust of the
    // server's materialization — is the kernel façade's call, not the feed's.
    this.#coreSemanticsVersion = welcome.core_semantics_version;
    this.#checkpoint = await this.store.checkpoint();
    this.#setState({
      status: "syncing",
      safeSeq: this.#checkpoint.safeSeq,
      headSeq: welcome.feed.head_seq,
      lastError: undefined,
    });

    // Cold start, and the one other case where a resume point is unusable before
    // the server has to say so: a feed floor above our watermark (v2 ACLs and any
    // future compaction — `floor_seq` is 0 in M2, PROTOCOL.md §1.4).
    const mustBootstrap =
      !this.#checkpoint.bootstrapped || welcome.feed.floor_seq > this.#checkpoint.safeSeq;
    if (mustBootstrap) {
      await this.#runBootstrap();
      return;
    }
    this.subscribe(this.#checkpoint.safeSeq);
  }

  /** Send `feed.subscribe` at `sinceSeq`. */
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

  /** Apply one batch: rows + watermark in a single store transaction. */
  async onBatch(batch: FeedBatch): Promise<void> {
    // A catch-up that started at seq 0 and ran to completion *is* a full pass:
    // every row with a `feed_seq` was delivered. Recording that spares a small
    // workspace a bootstrap round on every future boot.
    const bootstrapped =
      this.#checkpoint.bootstrapped || (batch.complete && this.#subscribedSince === 0);

    const checkpoint: SyncCheckpoint = {
      // PROTOCOL.md §2.2: the server's `safe_seq`, never `max(seq)` of the rows.
      safeSeq: batch.safe_seq,
      updatedAt: Date.now(),
      coreSemanticsVersion: this.#coreSemanticsVersion ?? this.#checkpoint.coreSemanticsVersion,
      bootstrapped,
    };
    // Rows and watermark in one transaction — `applyRows` is the only writer, and
    // it refuses to move `safeSeq` backwards.
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

  /** Run a bootstrap pass, then resubscribe at the pinned `safe_seq`. */
  async onReset(reset: FeedReset): Promise<void> {
    // Never clear the store first (SPEC §5.3, PROTOCOL.md §2.5): bootstrap rows
    // overwrite by id and `retainOnly` collects what the pass never mentioned.
    this.#setState({
      status: "syncing",
      lastError: `feed.reset: ${reset.reason}`,
      headSeq: reset.head_seq,
    });
    await this.#runBootstrap();
  }

  /** Re-subscribe at `from_seq`, keeping every local row. */
  onResync(resync: FeedResync): void {
    this.subscribe(resync.from_seq);
  }

  /** A connection attempt started. Local reads keep working throughout. */
  onConnecting(): void {
    this.#setState({ status: "connecting", lastError: undefined });
  }

  /** Socket closed: drop to `offline` (or `auth-required` on 4401). */
  onDisconnected(status: Extract<SyncStatus, "offline" | "auth-required" | "error">): void {
    this.#subscribedSince = undefined;
    this.#setState({ status, bootstrap: undefined });
  }

  /** `true` once a catch-up completed on this connection (backoff reset rule). */
  get caughtUp(): boolean {
    return this.#state.status === "synced";
  }

  /** The store this client writes into — the query engine reads from the same one. */
  get projection(): ProjectionStore {
    return this.store;
  }

  /** The bootstrap client, exposed for the first-run progress screen. */
  get bootstrapClient(): BootstrapClient {
    return this.bootstrap;
  }

  /**
   * One bootstrap pass, then resubscribe at the sequence number it pinned.
   * Cold start, `feed.reset`, and a floor above our watermark all land here.
   */
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
        // The socket died under the pass. The rows and the pinned watermark are
        // safely stored; the reconnect loop will `start()` again and tail from
        // there — no data was lost and nothing needs re-downloading.
        this.#setState({ status: "offline" });
        return;
      }
      this.subscribe(result.safeSeq);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cause instanceof BootstrapHttpError && cause.status === 401) {
        // Re-login, nothing else. Local data is untouched (SPEC §5.3).
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
