/**
 * IndexedDB implementation of {@link ProjectionStore} (SPEC §4.1).
 *
 * Schema (one store for the projection, one tiny store for metadata):
 *
 * ```text
 * db  "life-manager"            version DB_VERSION
 *   store "projection"          keyPath "id"
 *     index "seq"               on "seq"          (feed order, watermark repair)
 *     index "deleted"           on "deleted"     (Trash view)
 *     index "path"              on "fm.path"     (folders, M3)
 *     index "updated_at"        on "updated_at"  (doc-list default sort)
 *   store "meta"                keyPath "key"    — the SyncCheckpoint lives here
 *   store "docs"                keyPath "id"     — persisted Y.Doc updates for
 *                                                  recently edited documents
 * ```
 *
 * Implementation notes for the builder (all load-bearing):
 * - `applyRows` must run in **one** `readwrite` transaction spanning
 *   `projection` + `meta`, so the checkpoint can never outrun the rows.
 * - `iterate` must use a cursor, not `getAll`: 5 000 documents of up to 1 MiB
 *   each is not a thing to materialize in one array (SPEC §9 M2 gate).
 * - `navigator.storage.persist()` is called by the kernel at first login
 *   (SPEC §6.4), not here.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

import type { FeedRow } from "../protocol.js";
// Type-only: `DocPersistence` is the hydrator's contract for this store's `docs`
// half (web/CONTRACTS.md, area web-store). Erased at build time — `store/` still
// has no runtime edge to `sync/`.
import type { DocPersistence } from "../sync/doc-hydration.js";
import {
  EMPTY_CHECKPOINT,
  type AppliedRows,
  type ProjectionStore,
  type StoreChange,
  type StoreListener,
  type StoredRow,
  type SyncCheckpoint,
} from "./projection-store.js";

export const DB_NAME = "life-manager";
export const DB_VERSION = 1;
export const STORE_PROJECTION = "projection";
export const STORE_META = "meta";
export const STORE_DOCS = "docs";
export const CHECKPOINT_KEY = "sync-checkpoint";

/**
 * Rows read per `iterate` chunk. Each chunk is one transaction; the rows of one
 * chunk are the only ones held in memory at a time.
 */
export const ITERATE_CHUNK_ROWS = 50;

/** Local Y.Doc replicas kept by {@link IdbDocPersistence.prune} by default. */
export const DEFAULT_DOC_REPLICAS_KEPT = 20;

/** Persisted Y.Doc state for a recently edited document (SPEC §4.1, lazy hydration). */
export interface StoredDocState {
  readonly id: string;
  /** Encoded Yjs state, update encoding v1. */
  readonly state: Uint8Array;
  /** Client clock, for LRU eviction of the local replica set. */
  readonly touchedAt: number;
  /**
   * `true` ⇒ this replica holds local edits the server has not acknowledged, and
   * {@link IdbDocPersistence.prune} must not evict it however old it is. Absent on
   * records written before the flag existed, which are treated as possibly unsynced
   * (the conservative direction: a redundant prompt, never a lost edit).
   */
  readonly unsynced?: boolean;
}

export interface LifeManagerDb extends DBSchema {
  projection: {
    key: string;
    value: StoredRow;
    indexes: { seq: number; deleted: number; updated_at: string };
  };
  meta: { key: string; value: { key: string; value: unknown } };
  docs: { key: string; value: StoredDocState };
}

export class IdbProjectionStore implements ProjectionStore {
  #db: IDBPDatabase<LifeManagerDb> | undefined;
  readonly #listeners = new Set<StoreListener>();

  constructor(readonly name: string = DB_NAME) {}

  async open(): Promise<void> {
    this.#db ??= await openDB<LifeManagerDb>(this.name, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_PROJECTION)) {
          const rows = db.createObjectStore(STORE_PROJECTION, { keyPath: "id" });
          rows.createIndex("seq", "seq");
          // INTEGRATION (scaffold / whoever owns DB_VERSION): this index is dead
          // weight. IndexedDB has no boolean key type, so a row with
          // `deleted: false` is absent from it entirely and a Trash query cannot
          // use it. Both `iterate` and `count` filter in JS instead. Changing it
          // means a `DB_VERSION` bump (e.g. to a `deleted_at` index, which *is* a
          // valid key), so it is left in place rather than quietly diverging from
          // the frozen schema.
          rows.createIndex("deleted", "deleted");
          rows.createIndex("updated_at", "updated_at");
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORE_DOCS)) {
          db.createObjectStore(STORE_DOCS, { keyPath: "id" });
        }
      },
    });
  }

  async close(): Promise<void> {
    this.#db?.close();
    this.#db = undefined;
  }

  get db(): IDBPDatabase<LifeManagerDb> {
    if (!this.#db) throw new Error("IdbProjectionStore.open() has not been awaited");
    return this.#db;
  }

  async get(id: string): Promise<StoredRow | undefined> {
    return this.db.get(STORE_PROJECTION, id);
  }

  async getMany(ids: readonly string[]): Promise<StoredRow[]> {
    if (ids.length === 0) return [];
    const tx = this.db.transaction(STORE_PROJECTION, "readonly");
    const store = tx.objectStore(STORE_PROJECTION);
    const found: StoredRow[] = [];
    // One transaction, one request per id: IndexedDB has no multi-get, and a
    // cursor over the whole store would read far more than the caller asked for.
    for (const id of ids) {
      const row = await store.get(id);
      if (row) found.push(row);
    }
    await tx.done;
    return found;
  }

  /**
   * Stream every row in primary-key (= ULID, creation) order.
   *
   * Cursor-based and **chunked**: each chunk is one short-lived transaction that
   * walks a cursor from the last key it emitted. Yielding a row to the consumer
   * means awaiting whatever the consumer does with it (Wasm filter evaluation,
   * search indexing), and an IndexedDB transaction dies the moment the task
   * queue drains — so the transaction must not span the yield. Bounded memory
   * either way: at most `ITERATE_CHUNK_ROWS` rows are held at once, never the
   * 5 000 × 1 MiB of the M2 gate (SPEC §9 M2).
   *
   * Note on `includeDeleted`: the filtering is done in JS on purpose. The
   * `deleted` index cannot help — IndexedDB has no boolean key type, so
   * `deleted: false` rows are not even present in that index.
   */
  iterate(options?: { readonly includeDeleted?: boolean }): AsyncIterable<StoredRow> {
    const includeDeleted = options?.includeDeleted ?? false;
    const self = this;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<StoredRow> {
        let after: string | undefined;
        for (;;) {
          const chunk = await self.#chunk(after, includeDeleted);
          for (const row of chunk.rows) yield row;
          // `lastKey` is set only when the chunk filled up; an exhausted store
          // ends the walk even if this chunk yielded nothing (all rows deleted).
          if (chunk.lastKey === undefined) return;
          after = chunk.lastKey;
        }
      },
    };
  }

  async count(options?: { readonly includeDeleted?: boolean }): Promise<number> {
    if (options?.includeDeleted ?? false) return this.db.count(STORE_PROJECTION);
    // Live rows only: `deleted` is a boolean, which IndexedDB refuses as a key,
    // so there is no index to count through. Key-only cursor walk over the
    // values is the honest implementation; callers use it for empty-state checks
    // and progress readouts, not per-keystroke.
    let live = 0;
    for await (const row of this.iterate({ includeDeleted: false })) {
      if (row) live++;
    }
    return live;
  }

  /**
   * Rows **and** watermark in one `readwrite` transaction over
   * `projection` + `meta` (PROTOCOL.md §2.4). A crash between the two halves is
   * exactly how a client silently loses a document forever, so there is no
   * "write rows, then advance checkpoint" path anywhere in this class.
   *
   * Rows are LWW by `seq`; `purged` rows delete. The stored `safeSeq` never
   * moves backwards — batches can only be applied in order, and a re-subscribe
   * at a lower `from_seq` (`feed.resync`) must not rewind the watermark.
   */
  async applyRows(
    rows: readonly FeedRow[],
    checkpoint: SyncCheckpoint,
  ): Promise<AppliedRows> {
    const applied: string[] = [];
    const purged: string[] = [];
    const ignored: string[] = [];

    const tx = this.db.transaction([STORE_PROJECTION, STORE_META], "readwrite");
    const projection = tx.objectStore(STORE_PROJECTION);
    const meta = tx.objectStore(STORE_META);

    /** Effective seq per id within this batch (the server collapses repeats, but never trust that). */
    const seen = new Map<string, number>();

    for (const row of rows) {
      const knownSeq = seen.get(row.id) ?? (await projection.get(row.id))?.seq;
      if (knownSeq !== undefined && row.seq <= knownSeq) {
        ignored.push(row.id);
        continue;
      }
      seen.set(row.id, row.seq);
      if (row.purged) {
        await projection.delete(row.id);
        purged.push(row.id);
        // INTEGRATION (web-sync): the matching local Y.Doc replica in `docs` is
        // *not* dropped here. A replica may hold unsynced edits the user must be
        // offered back first (SPEC §4.1), and that conversation belongs to the
        // hydrator — it listens for these ids through `subscribe`.
        continue;
      }
      await projection.put(toStoredRow(row));
      applied.push(row.id);
    }

    const stored = (await meta.get(CHECKPOINT_KEY))?.value as SyncCheckpoint | undefined;
    const next: SyncCheckpoint = {
      ...checkpoint,
      safeSeq: Math.max(checkpoint.safeSeq, stored?.safeSeq ?? 0),
    };
    await meta.put({ key: CHECKPOINT_KEY, value: next });
    await tx.done;

    this.emit({ applied, purged, safeSeq: next.safeSeq });
    return { applied, purged, ignored };
  }

  /**
   * Bootstrap garbage collection (PROTOCOL.md §4): the **only** path that drops
   * rows nobody asked to drop, and only ever after a *complete* bootstrap pass.
   */
  async retainOnly(ids: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    const tx = this.db.transaction(STORE_PROJECTION, "readwrite");
    let cursor = await tx.objectStore(STORE_PROJECTION).openKeyCursor();
    while (cursor) {
      if (!ids.has(cursor.primaryKey)) removed.push(cursor.primaryKey);
      cursor = await cursor.continue();
    }
    for (const id of removed) await tx.objectStore(STORE_PROJECTION).delete(id);
    await tx.done;
    if (removed.length > 0) {
      const checkpoint = await this.checkpoint();
      this.emit({ applied: [], purged: removed, safeSeq: checkpoint.safeSeq });
    }
    return removed;
  }

  /** One chunk of {@link iterate}: a fresh transaction, a cursor, bounded rows. */
  async #chunk(
    after: string | undefined,
    includeDeleted: boolean,
  ): Promise<{ rows: StoredRow[]; lastKey: string | undefined }> {
    const range = after === undefined ? null : IDBKeyRange.lowerBound(after, true);
    const tx = this.db.transaction(STORE_PROJECTION, "readonly");
    const rows: StoredRow[] = [];
    let lastKey: string | undefined;
    let scanned = 0;
    let cursor = await tx.objectStore(STORE_PROJECTION).openCursor(range);
    while (cursor) {
      lastKey = cursor.primaryKey;
      scanned++;
      if (includeDeleted || !cursor.value.deleted) rows.push(cursor.value);
      if (scanned >= ITERATE_CHUNK_ROWS) break;
      cursor = await cursor.continue();
    }
    await tx.done.catch(() => undefined);
    // `lastKey === undefined` ⇒ the store is exhausted; a short chunk that did
    // scan rows still has to come back for the next key range.
    return { rows, lastKey: scanned >= ITERATE_CHUNK_ROWS ? lastKey : undefined };
  }

  async checkpoint(): Promise<SyncCheckpoint> {
    const row = await this.db.get(STORE_META, CHECKPOINT_KEY);
    return (row?.value as SyncCheckpoint | undefined) ?? EMPTY_CHECKPOINT;
  }

  async setCheckpoint(checkpoint: SyncCheckpoint): Promise<void> {
    await this.db.put(STORE_META, { key: CHECKPOINT_KEY, value: checkpoint });
  }

  subscribe(listener: StoreListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction([STORE_PROJECTION, STORE_META, STORE_DOCS], "readwrite");
    await Promise.all([
      tx.objectStore(STORE_PROJECTION).clear(),
      tx.objectStore(STORE_META).clear(),
      tx.objectStore(STORE_DOCS).clear(),
      tx.done,
    ]);
  }

  /** Fan a change out to subscribers. Implementations call this after a write. */
  protected emit(change: StoreChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}

/**
 * A feed row, normalized for storage.
 *
 * Structured clone rejects nothing we carry (the shared-core value model is
 * JSON-shaped), but the row must be a plain object: it arrives as a frozen
 * `readonly` view in TypeScript and may be a reused parse buffer. `content` is
 * kept absent rather than `undefined` when the subscription is metadata-only, so
 * "no content replicated" and "content is the empty string" stay distinguishable.
 */
function toStoredRow(row: FeedRow): StoredRow {
  const stored: Record<string, unknown> = {
    id: row.id,
    seq: row.seq,
    title: row.title,
    fm: row.fm,
    plugins: row.plugins,
    fm_parse_error: row.fm_parse_error,
    materialized_version: row.materialized_version,
    created_at: row.created_at,
    created_by: row.created_by,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
    deleted: row.deleted,
    deleted_at: row.deleted_at,
    deleted_by: row.deleted_by,
    purged: false,
  };
  if (row.content !== undefined) stored.content = row.content;
  return stored as unknown as StoredRow;
}

/**
 * The `docs` store as local replica storage for hydrated documents (SPEC §4.1:
 * "persisted locally for recently/currently edited docs" — the reason an opened
 * document is editable offline at all).
 *
 * Structurally implements `DocPersistence` from `sync/doc-hydration.ts`; the type
 * is imported for checking only, so `store/` keeps no runtime dependency on
 * `sync/`.
 */
export class IdbDocPersistence implements DocPersistence {
  /**
   * Last stamp handed out. `Date.now()` has millisecond granularity, and opening
   * a handful of documents in one tick would otherwise give them all the same
   * recency — making eviction order arbitrary exactly when it matters. Stamps are
   * therefore strictly increasing within a session, and still wall-clock ordered
   * across sessions.
   */
  #lastStamp = 0;

  constructor(private readonly store: IdbProjectionStore) {}

  async load(id: string): Promise<Uint8Array | undefined> {
    const row = await this.store.db.get(STORE_DOCS, id);
    if (!row) return undefined;
    // Touch on read: opening a document is what makes it "recently edited" for
    // the purposes of the local replica budget.
    await this.store.db.put(STORE_DOCS, { ...row, touchedAt: this.#stamp() });
    return row.state;
  }

  /**
   * The replica and its flags, without touching its recency — the read the purge
   * path uses, where "did this hold unsynced edits?" is the whole question and
   * bumping the LRU of a document that is about to be deleted would be nonsense.
   */
  async peek(id: string): Promise<{ state: Uint8Array; unsynced?: boolean } | undefined> {
    const row = await this.store.db.get(STORE_DOCS, id);
    if (!row) return undefined;
    return row.unsynced === undefined
      ? { state: row.state }
      : { state: row.state, unsynced: row.unsynced };
  }

  async save(id: string, state: Uint8Array, meta?: { readonly unsynced: boolean }): Promise<void> {
    await this.store.db.put(STORE_DOCS, {
      id,
      state,
      touchedAt: this.#stamp(),
      unsynced: meta?.unsynced ?? false,
    });
  }

  #stamp(): number {
    this.#lastStamp = Math.max(Date.now(), this.#lastStamp + 1);
    return this.#lastStamp;
  }

  async drop(id: string): Promise<void> {
    await this.store.db.delete(STORE_DOCS, id);
  }

  /**
   * Evict the least-recently-touched replicas beyond `keep`. Only `state` blobs
   * go — the projection row stays, so the document remains readable and
   * searchable offline (it is merely no longer editable offline).
   *
   * **A replica holding unsynced edits is never evicted**, however old it is. Pure
   * LRU here contradicts the hydrator's stated invariant ("local edits are never
   * dropped to make room") in the one case where it matters: edit a document
   * offline, then browse fifty others, and the blob carrying the only copy of that
   * edit falls out of the window. The in-memory Y.Doc still has it, so a reconnect
   * in the same session recovers — but a reload first loses the edit, with the
   * projection row still present so nothing tells the user anything happened.
   *
   * The budget is therefore a budget over *evictable* replicas. A user who edits
   * more than `keep` documents offline keeps all of them; that is the correct
   * failure direction, and the kernel already surfaces storage-quota warnings
   * (SPEC §6.4).
   */
  async prune(keep: number = DEFAULT_DOC_REPLICAS_KEPT): Promise<string[]> {
    const tx = this.store.db.transaction(STORE_DOCS, "readwrite");
    const docs = tx.objectStore(STORE_DOCS);
    const evictable: Array<{ id: string; touchedAt: number }> = [];
    let pinned = 0;
    let cursor = await docs.openCursor();
    while (cursor) {
      // `unsynced === undefined` is a record from before the flag: treated as
      // evictable, because every record this version writes carries the flag and a
      // legacy blob has already survived one session without it.
      if (cursor.value.unsynced === true) pinned++;
      else evictable.push({ id: cursor.value.id, touchedAt: cursor.value.touchedAt });
      cursor = await cursor.continue();
    }
    evictable.sort((a, b) => b.touchedAt - a.touchedAt || (a.id < b.id ? -1 : 1));
    const room = Math.max(Math.max(keep, 0) - pinned, 0);
    const evicted = evictable.slice(room).map((entry) => entry.id);
    for (const id of evicted) await docs.delete(id);
    await tx.done;
    return evicted;
  }
}
