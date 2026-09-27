/**
 * The projection store contract (SPEC §4.1: "Stored in one IndexedDB store").
 *
 * **FROZEN INTERFACE.** The sync client, the query engine and (in M3) the
 * `@kernel.documents` surface all program against `ProjectionStore`; the
 * IndexedDB implementation is free to change behind it, and tests substitute an
 * in-memory one.
 */

import type { FeedRow, ProjectionRow } from "../protocol.js";

/** Where the client is in the change feed. Persisted with the rows it describes. */
export interface SyncCheckpoint {
  /**
   * The resume point: the server's `safe_seq`, never `max(seq)` seen
   * (PROTOCOL.md §2.2). `0` ⇒ nothing replicated yet.
   */
  readonly safeSeq: number;
  /** When the checkpoint was last advanced (client clock, display only). */
  readonly updatedAt: number;
  /** Server `core_semantics_version` the rows were materialized by. */
  readonly coreSemanticsVersion: number | null;
  /** `true` once a full bootstrap pass completed at least once. */
  readonly bootstrapped: boolean;
}

export const EMPTY_CHECKPOINT: SyncCheckpoint = {
  safeSeq: 0,
  updatedAt: 0,
  coreSemanticsVersion: null,
  bootstrapped: false,
};

/** Result of applying a batch of feed rows. */
export interface AppliedRows {
  /** Ids written (insert or overwrite). */
  readonly applied: readonly string[];
  /** Ids removed because the row was `purged`. */
  readonly purged: readonly string[];
  /** Ids skipped because a newer `seq` was already stored. */
  readonly ignored: readonly string[];
}

/** A change notification for live-updating queries (SPEC §4.2). */
export interface StoreChange {
  readonly applied: readonly string[];
  readonly purged: readonly string[];
  readonly safeSeq: number;
}

export type StoreListener = (change: StoreChange) => void;

/** A row as stored locally: the projection plus its feed sequence number. */
export interface StoredRow extends ProjectionRow {
  readonly seq: number;
  /**
   * `true` ⇒ written by this device, not the feed: a note made offline (`seq` 0), or an
   * offline edit, trash or restore shown before the server has it. The feed's next row
   * for the id (a higher `seq`) replaces it.
   */
  readonly local?: boolean;
}

export interface ProjectionStore {
  /** Open (and migrate) the database. Idempotent. */
  open(): Promise<void>;
  close(): Promise<void>;

  get(id: string): Promise<StoredRow | undefined>;
  getMany(ids: readonly string[]): Promise<StoredRow[]>;
  /** Stream every row; the query engine and the search indexer use this. */
  iterate(options?: { readonly includeDeleted?: boolean }): AsyncIterable<StoredRow>;
  count(options?: { readonly includeDeleted?: boolean }): Promise<number>;

  /**
   * Apply feed rows **and** advance the checkpoint in one transaction
   * (PROTOCOL.md §2.4 — a crash must never leave the watermark ahead of the
   * rows). Rows with a `seq` not newer than the stored one are ignored; rows
   * with `purged: true` delete the local row.
   */
  applyRows(rows: readonly FeedRow[], checkpoint: SyncCheckpoint): Promise<AppliedRows>;

  /**
   * Bootstrap garbage collection (PROTOCOL.md §4): after a complete pass, drop
   * every local row whose id the pass never mentioned. Returns the ids removed.
   */
  retainOnly(ids: ReadonlySet<string>): Promise<string[]>;

  /**
   * Write rows this device derived itself ({@link StoredRow.local}), whatever their
   * `seq`, and tell the listeners. The feed still wins: its next row for an id has a
   * higher `seq`. Optional: a store without it cannot show offline changes early.
   */
  putLocal?(rows: readonly StoredRow[]): Promise<void>;
  /** Drop rows this device made up (a local create the server refused). */
  deleteLocal?(ids: readonly string[]): Promise<void>;
  /** Small per-device values kept beside the checkpoint (the outbox). */
  getMeta?<T>(key: string): Promise<T | undefined>;
  setMeta?(key: string, value: unknown): Promise<void>;

  checkpoint(): Promise<SyncCheckpoint>;
  setCheckpoint(checkpoint: SyncCheckpoint): Promise<void>;

  /** Subscribe to store changes. Returns an unsubscribe function. */
  subscribe(listener: StoreListener): () => void;

  /**
   * Drop everything. Only ever called on explicit logout (SPEC §5.3) — never on
   * a 401, never on a `feed.reset`.
   */
  clear(): Promise<void>;
}
