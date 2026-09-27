/**
 * Test-only helpers for the projection store and everything built on it.
 *
 * Not re-exported from `store/index.ts` and never imported by production code:
 * `web/CONTRACTS.md` says the sync client programs against `ProjectionStore`, and
 * this is the in-memory substitute that keeps that honest. The IndexedDB
 * implementation is tested against `fake-indexeddb` separately.
 */

import * as Y from "yjs";

import type { DocReplicaMeta, JournalEntry } from "../sync/doc-hydration.js";
import type { FeedRow } from "../protocol.js";
import {
  EMPTY_CHECKPOINT,
  type AppliedRows,
  type ProjectionStore,
  type StoreChange,
  type StoreListener,
  type StoredRow,
  type SyncCheckpoint,
} from "./projection-store.js";

/** A feed row with plausible defaults; override whatever the test cares about. */
export function feedRow(overrides: Partial<FeedRow> & { id: string; seq: number }): FeedRow {
  return {
    title: `doc ${overrides.id}`,
    content: `# doc ${overrides.id}\n`,
    fm: {},
    plugins: {},
    fm_parse_error: false,
    materialized_version: "v1",
    created_at: "2026-09-24T09:00:00.000Z",
    created_by: "01J8ZUSER0000000000000000",
    updated_at: "2026-09-24T09:00:00.000Z",
    updated_by: "01J8ZUSER0000000000000000",
    deleted: false,
    deleted_at: null,
    deleted_by: null,
    purged: false,
    ...overrides,
  };
}

/**
 * In-memory `ProjectionStore` with the same semantics the IndexedDB one
 * promises: LWW by `seq`, purge deletes, the watermark never moves backwards,
 * and listeners fire once per applied batch.
 */
export class MemoryProjectionStore implements ProjectionStore {
  readonly rows = new Map<string, StoredRow>();
  #checkpoint: SyncCheckpoint = EMPTY_CHECKPOINT;
  readonly #listeners = new Set<StoreListener>();
  /** Every batch that was applied, for ordering assertions. */
  readonly batches: Array<{ rows: readonly FeedRow[]; checkpoint: SyncCheckpoint }> = [];
  cleared = 0;

  async open(): Promise<void> {}
  async close(): Promise<void> {}

  async get(id: string): Promise<StoredRow | undefined> {
    return this.rows.get(id);
  }

  async getMany(ids: readonly string[]): Promise<StoredRow[]> {
    const found: StoredRow[] = [];
    for (const id of ids) {
      const row = this.rows.get(id);
      if (row) found.push(row);
    }
    return found;
  }

  iterate(options?: { readonly includeDeleted?: boolean }): AsyncIterable<StoredRow> {
    const rows = [...this.rows.values()]
      .filter((row) => (options?.includeDeleted ?? false) || !row.deleted)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return {
      async *[Symbol.asyncIterator]() {
        for (const row of rows) yield row;
      },
    };
  }

  async count(options?: { readonly includeDeleted?: boolean }): Promise<number> {
    let total = 0;
    for await (const row of this.iterate(options)) if (row) total++;
    return total;
  }

  async applyRows(rows: readonly FeedRow[], checkpoint: SyncCheckpoint): Promise<AppliedRows> {
    this.batches.push({ rows, checkpoint });
    const applied: string[] = [];
    const purged: string[] = [];
    const ignored: string[] = [];
    for (const row of rows) {
      const known = this.rows.get(row.id)?.seq;
      if (known !== undefined && row.seq <= known) {
        ignored.push(row.id);
        continue;
      }
      if (row.purged) {
        this.rows.delete(row.id);
        purged.push(row.id);
        continue;
      }
      this.rows.set(row.id, { ...row } as StoredRow);
      applied.push(row.id);
    }
    this.#checkpoint = {
      ...checkpoint,
      safeSeq: Math.max(checkpoint.safeSeq, this.#checkpoint.safeSeq),
    };
    this.#emit({ applied, purged, safeSeq: this.#checkpoint.safeSeq });
    return { applied, purged, ignored };
  }

  readonly meta = new Map<string, unknown>();

  async putLocal(rows: readonly StoredRow[]): Promise<void> {
    for (const row of rows) this.rows.set(row.id, { ...row, local: true });
    if (rows.length > 0) this.#emit({ applied: rows.map((row) => row.id), purged: [], safeSeq: this.#checkpoint.safeSeq });
  }

  async deleteLocal(ids: readonly string[]): Promise<void> {
    for (const id of ids) if (this.rows.get(id)?.local) this.rows.delete(id);
    if (ids.length > 0) this.#emit({ applied: [], purged: [...ids], safeSeq: this.#checkpoint.safeSeq });
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return this.meta.get(key) as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    this.meta.set(key, structuredClone(value));
  }

  async retainOnly(ids: ReadonlySet<string>): Promise<string[]> {
    const removed = [...this.rows.entries()]
      .filter(([id, row]) => !ids.has(id) && !(row.local === true && row.seq === 0))
      .map(([id]) => id);
    for (const id of removed) this.rows.delete(id);
    if (removed.length > 0) {
      this.#emit({ applied: [], purged: removed, safeSeq: this.#checkpoint.safeSeq });
    }
    return removed;
  }

  async checkpoint(): Promise<SyncCheckpoint> {
    return this.#checkpoint;
  }

  async setCheckpoint(checkpoint: SyncCheckpoint): Promise<void> {
    this.#checkpoint = checkpoint;
  }

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async clear(): Promise<void> {
    this.cleared++;
    this.rows.clear();
    this.#checkpoint = EMPTY_CHECKPOINT;
  }

  #emit(change: StoreChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}

/**
 * In-memory `DocPersistence` (the `docs` store's contract), with call counts.
 *
 * Mirrors `IdbDocPersistence` in the two places where behaviour, not storage, is
 * the contract: `save` records the `unsynced` flag, and `prune` refuses to evict a
 * replica carrying it.
 */
export class MemoryDocPersistence {
  readonly states = new Map<
    string,
    { state: Uint8Array; touchedAt: number; unsynced: boolean; journal?: readonly JournalEntry[]; version?: string }
  >();
  saves = 0;
  drops = 0;
  #clock = 0;

  async load(id: string): Promise<Uint8Array | undefined> {
    const entry = this.states.get(id);
    if (!entry) return undefined;
    entry.touchedAt = ++this.#clock;
    return entry.state;
  }

  async peek(
    id: string,
  ): Promise<{ state: Uint8Array; unsynced: boolean; journal?: readonly JournalEntry[] } | undefined> {
    const entry = this.states.get(id);
    if (!entry) return undefined;
    return { state: entry.state, unsynced: entry.unsynced, ...(entry.journal ? { journal: entry.journal } : {}) };
  }

  async save(id: string, state: Uint8Array, meta?: DocReplicaMeta): Promise<void> {
    this.saves++;
    const version = this.states.get(id)?.version;
    this.states.set(id, {
      state,
      touchedAt: ++this.#clock,
      ...(version === undefined ? {} : { version }),
      unsynced: meta?.unsynced ?? false,
      ...(meta?.journal && meta.journal.length > 0 ? { journal: [...meta.journal] } : {}),
    });
  }

  async absorb(id: string, state: Uint8Array, version: string): Promise<void> {
    const existing = this.states.get(id);
    this.states.set(id, {
      ...(existing ?? { unsynced: false, touchedAt: ++this.#clock }),
      state: existing ? Y.mergeUpdates([existing.state, state]) : state,
      version,
    });
  }

  async list(): Promise<Array<{ id: string; unsynced: boolean; version?: string }>> {
    return [...this.states.entries()].map(([id, entry]) => ({
      id,
      unsynced: entry.unsynced,
      ...(entry.version === undefined ? {} : { version: entry.version }),
    }));
  }

  async drop(id: string): Promise<void> {
    this.drops++;
    this.states.delete(id);
  }

  async prune(keep: number): Promise<string[]> {
    const entries = [...this.states.entries()];
    const pinned = entries.filter(([, entry]) => entry.unsynced).length;
    const evicted = entries
      .filter(([, entry]) => !entry.unsynced)
      .sort((a, b) => b[1].touchedAt - a[1].touchedAt)
      .slice(Math.max(Math.max(keep, 0) - pinned, 0))
      .map(([id]) => id);
    for (const id of evicted) this.states.delete(id);
    return evicted;
  }
}
