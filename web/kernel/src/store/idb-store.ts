import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import * as Y from "yjs";

import type { FeedRow } from "../protocol.js";
import { TAB_ID, type DocPersistence, type DocReplicaMeta, type JournalEntry, type StoredReplica } from "../sync/doc-hydration.js";
import {
  EMPTY_CHECKPOINT,
  type AppliedRows,
  type ProjectionStore,
  type StoreChange,
  type StoreListener,
  type StoredRow,
  type SyncCheckpoint,
} from "./projection-store.js";

export const DB_NAME = "ddd";
export const DB_VERSION = 1;
export const STORE_PROJECTION = "projection";
export const STORE_META = "meta";
export const STORE_DOCS = "docs";
export const CHECKPOINT_KEY = "sync-checkpoint";

export const ITERATE_CHUNK_ROWS = 50;

export const DEFAULT_DOC_REPLICAS_KEPT = 20;

export interface StoredDocState {
  readonly id: string;
  readonly state: Uint8Array;
  readonly touchedAt: number;
  readonly unsynced?: boolean;
  readonly journal?: readonly JournalEntry[];
  readonly version?: string;
}

export interface DddDb extends DBSchema {
  projection: {
    key: string;
    value: StoredRow;
    indexes: { seq: number; deleted: number; updated_at: string };
  };
  meta: { key: string; value: { key: string; value: unknown } };
  docs: { key: string; value: StoredDocState };
}

export class IdbProjectionStore implements ProjectionStore {
  #db: IDBPDatabase<DddDb> | undefined;
  readonly #listeners = new Set<StoreListener>();
  #channel: BroadcastChannel | undefined;

  constructor(readonly name: string = DB_NAME) {}

  #openChannel(): void {
    if (this.#channel || typeof BroadcastChannel === "undefined") return;
    try {
      const channel = new BroadcastChannel(`${this.name}:projection`);
      channel.onmessage = (event: MessageEvent<StoreChange>) => {
        const change = event.data;
        if (!change || !Array.isArray(change.applied) || !Array.isArray(change.purged)) return;
        this.#fanOut(change);
      };
      this.#channel = channel;
    } catch {
    }
  }

  async open(): Promise<void> {
    this.#openChannel();
    this.#db ??= await openDB<DddDb>(this.name, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_PROJECTION)) {
          const rows = db.createObjectStore(STORE_PROJECTION, { keyPath: "id" });
          rows.createIndex("seq", "seq");
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
    this.#channel?.close();
    this.#channel = undefined;
  }

  get db(): IDBPDatabase<DddDb> {
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
    for (const id of ids) {
      const row = await store.get(id);
      if (row) found.push(row);
    }
    await tx.done;
    return found;
  }

  iterate(options?: { readonly includeDeleted?: boolean }): AsyncIterable<StoredRow> {
    const includeDeleted = options?.includeDeleted ?? false;
    const self = this;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<StoredRow> {
        let after: string | undefined;
        for (;;) {
          const chunk = await self.#chunk(after, includeDeleted);
          for (const row of chunk.rows) yield row;
          if (chunk.lastKey === undefined) return;
          after = chunk.lastKey;
        }
      },
    };
  }

  async count(options?: { readonly includeDeleted?: boolean }): Promise<number> {
    if (options?.includeDeleted ?? false) return this.db.count(STORE_PROJECTION);
    let live = 0;
    for await (const row of this.iterate({ includeDeleted: false })) {
      if (row) live++;
    }
    return live;
  }

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

  async retainOnly(ids: ReadonlySet<string>): Promise<string[]> {
    const removed: string[] = [];
    const tx = this.db.transaction(STORE_PROJECTION, "readwrite");
    let cursor = await tx.objectStore(STORE_PROJECTION).openCursor();
    while (cursor) {
      const madeHere = cursor.value.local === true && cursor.value.seq === 0;
      if (!ids.has(cursor.primaryKey) && !madeHere) removed.push(cursor.primaryKey);
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
    return { rows, lastKey: scanned >= ITERATE_CHUNK_ROWS ? lastKey : undefined };
  }

  async putLocal(rows: readonly StoredRow[]): Promise<void> {
    if (rows.length === 0) return;
    const tx = this.db.transaction(STORE_PROJECTION, "readwrite");
    for (const row of rows) await tx.store.put({ ...row, local: true });
    await tx.done;
    const checkpoint = await this.checkpoint();
    this.emit({ applied: rows.map((row) => row.id), purged: [], safeSeq: checkpoint.safeSeq });
  }

  async deleteLocal(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const tx = this.db.transaction(STORE_PROJECTION, "readwrite");
    for (const id of ids) {
      if ((await tx.store.get(id))?.local) await tx.store.delete(id);
    }
    await tx.done;
    const checkpoint = await this.checkpoint();
    this.emit({ applied: [], purged: [...ids], safeSeq: checkpoint.safeSeq });
  }

  async getMeta<T>(key: string): Promise<T | undefined> {
    return (await this.db.get(STORE_META, key))?.value as T | undefined;
  }

  async setMeta(key: string, value: unknown): Promise<void> {
    await this.db.put(STORE_META, { key, value });
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

  protected emit(change: StoreChange): void {
    this.#fanOut(change);
    try {
      this.#channel?.postMessage(change);
    } catch {
    }
  }

  #fanOut(change: StoreChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}

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

export class IdbDocPersistence implements DocPersistence {
  #lastStamp = 0;

  constructor(private readonly store: IdbProjectionStore) {}

  async load(id: string): Promise<Uint8Array | undefined> {
    const row = await this.store.db.get(STORE_DOCS, id);
    if (!row) return undefined;
    await this.store.db.put(STORE_DOCS, { ...row, touchedAt: this.#stamp() });
    return row.state;
  }

  async peek(id: string): Promise<StoredReplica | undefined> {
    const row = await this.store.db.get(STORE_DOCS, id);
    if (!row) return undefined;
    return {
      state: row.state,
      ...(row.unsynced === undefined ? {} : { unsynced: row.unsynced }),
      ...(row.journal === undefined ? {} : { journal: row.journal }),
    };
  }

  async save(id: string, state: Uint8Array, meta?: DocReplicaMeta): Promise<void> {
    const tx = this.store.db.transaction(STORE_DOCS, "readwrite");
    const existing = await tx.store.get(id);
    const ours = meta?.journal ?? [];
    let foreign: JournalEntry[] = [];
    let merged = state;
    try {
      foreign = (existing?.journal ?? []).filter((entry) => entry.origin !== TAB_ID && !holds(state, entry.update));
      if (existing !== undefined && (foreign.length > 0 || !covers(state, existing.state))) {
        merged = Y.mergeUpdates([existing.state, state]);
      }
    } catch {
      foreign = [];
      merged = state;
    }
    const journal = [...foreign, ...ours].sort((a, b) => a.at - b.at);
    await tx.store.put({
      id,
      state: merged,
      touchedAt: this.#stamp(),
      unsynced: (meta?.unsynced ?? false) || foreign.length > 0,
      ...(journal.length > 0 ? { journal } : {}),
      ...(existing?.version === undefined ? {} : { version: existing.version }),
    });
    await tx.done;
  }

  async absorb(id: string, state: Uint8Array, version: string): Promise<void> {
    const tx = this.store.db.transaction(STORE_DOCS, "readwrite");
    const existing = await tx.store.get(id);
    let merged = state;
    if (existing !== undefined) {
      try {
        merged = covers(existing.state, state) ? existing.state : Y.mergeUpdates([existing.state, state]);
      } catch {
        merged = state;
      }
    }
    await tx.store.put({
      ...(existing ?? { unsynced: false }),
      id,
      state: merged,
      touchedAt: existing?.touchedAt ?? this.#stamp(),
      version,
    });
    await tx.done;
  }

  async list(): Promise<Array<{ id: string; unsynced: boolean; version?: string }>> {
    const found: Array<{ id: string; unsynced: boolean; version?: string }> = [];
    let cursor = await this.store.db.transaction(STORE_DOCS).store.openCursor();
    while (cursor) {
      const { id, unsynced, version } = cursor.value;
      found.push({ id, unsynced: unsynced === true, ...(version === undefined ? {} : { version }) });
      cursor = await cursor.continue();
    }
    return found;
  }

  #stamp(): number {
    this.#lastStamp = Math.max(Date.now(), this.#lastStamp + 1);
    return this.#lastStamp;
  }

  async drop(id: string): Promise<void> {
    await this.store.db.delete(STORE_DOCS, id);
  }

  async prune(keep: number = DEFAULT_DOC_REPLICAS_KEPT): Promise<string[]> {
    const tx = this.store.db.transaction(STORE_DOCS, "readwrite");
    const docs = tx.objectStore(STORE_DOCS);
    const evictable: Array<{ id: string; touchedAt: number }> = [];
    let pinned = 0;
    let cursor = await docs.openCursor();
    while (cursor) {
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

function holds(state: Uint8Array, update: Uint8Array): boolean {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const vector = Y.encodeStateVector(doc);
  const text = doc.getText("content").toString();
  Y.applyUpdate(doc, update);
  const same =
    text === doc.getText("content").toString() && equalBytes(vector, Y.encodeStateVector(doc));
  doc.destroy();
  return same;
}

function covers(state: Uint8Array, other: Uint8Array): boolean {
  const ours = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(state));
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVectorFromUpdate(other))) {
    if ((ours.get(client) ?? 0) < clock) return false;
  }
  return true;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
