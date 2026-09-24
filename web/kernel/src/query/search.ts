/**
 * Full-text search over the projection (SPEC §4.2).
 *
 * MiniSearch, built in a Web Worker, **persisted and incrementally updated** —
 * never a cold-start main-thread rebuild. The worker lives in
 * `worker-search.ts` / `search-worker.ts`; the interface below is what both the
 * in-process and the worker-backed implementation satisfy, so moving between
 * them costs no callers.
 *
 * **FROZEN INTERFACE.**
 */

import MiniSearch, { type Options as MiniSearchOptions } from "minisearch";

import type { CoreValue, ProjectionRow } from "../protocol.js";

export interface SearchHit {
  readonly id: string;
  readonly score: number;
  /** Fields that matched, for result highlighting. */
  readonly terms: readonly string[];
}

export interface SearchOptions {
  readonly limit?: number;
  readonly prefix?: boolean;
  readonly fuzzy?: number | boolean;
  readonly fields?: readonly ("title" | "content" | "fm")[];
  readonly includeDeleted?: boolean;
}

export interface SearchStats {
  readonly documents: number;
  /** Serialized index size in bytes, when known. */
  readonly bytes?: number;
  readonly builtAt?: number;
  /** The projection watermark the index reflects. */
  readonly safeSeq: number;
}

export interface SearchIndex {
  /** Load a persisted index, or start an empty one. */
  open(): Promise<void>;
  /** Add or replace rows. Called with every applied feed batch. */
  upsert(rows: readonly ProjectionRow[]): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<readonly SearchHit[]>;
  /** Persist the serialized index plus its watermark. */
  persist(safeSeq: number): Promise<void>;
  stats(): Promise<SearchStats>;
  /** Drop and rebuild from the store (only after `feed.reset`/schema change). */
  rebuild(rows: AsyncIterable<ProjectionRow>): Promise<void>;
  close(): Promise<void>;
}

/** Fields indexed, and their boosts. Changing this invalidates persisted indexes. */
export const SEARCH_FIELDS = {
  title: 3,
  content: 1,
  /** Flattened `fm` scalar values, joined — tags and paths are searchable. */
  fm: 2,
} as const;

/** Bump when the index shape changes; a mismatch forces one rebuild. */
export const SEARCH_INDEX_VERSION = 1;

// ---------------------------------------------------------------------------
// Persistence (the "no cold-start rebuild" half of SPEC §4.2)
// ---------------------------------------------------------------------------

/** What a persisted index looks like on disk. Opaque to callers. */
export interface PersistedIndex {
  readonly version: number;
  /** The projection watermark the serialized index reflects. */
  readonly safeSeq: number;
  readonly builtAt: number;
  readonly documents: number;
  /** `MiniSearch#toJSON()`, already stringified. */
  readonly index: string;
}

/**
 * Where a serialized index lives. IndexedDB in a browser or worker, memory in
 * tests and the Node harness.
 */
export interface SearchPersistence {
  load(): Promise<PersistedIndex | undefined>;
  save(entry: PersistedIndex): Promise<void>;
  clear(): Promise<void>;
  close?(): Promise<void>;
}

/** Test/harness persistence: survives `close()`, not the process. */
export class MemorySearchPersistence implements SearchPersistence {
  #entry: PersistedIndex | undefined;

  load(): Promise<PersistedIndex | undefined> {
    return Promise.resolve(this.#entry);
  }

  save(entry: PersistedIndex): Promise<void> {
    this.#entry = entry;
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#entry = undefined;
    return Promise.resolve();
  }
}

/** IndexedDB database holding the serialized search index. */
export const SEARCH_DB_NAME = "life-manager-search";
export const SEARCH_DB_VERSION = 1;
export const SEARCH_STORE = "index";
export const SEARCH_ENTRY_KEY = "projection";

/**
 * The browser/worker persistence.
 *
 * Its own database on purpose: the projection database (`store/idb-store.ts`) is
 * another area's schema, and a derived cache must never be able to force a
 * version bump — or a failed upgrade — on the store that holds the only local
 * copy of the workspace. A lost index costs one rebuild; a lost projection costs
 * a full bootstrap.
 */
export class IdbSearchPersistence implements SearchPersistence {
  #db: Promise<IDBDatabase> | undefined;

  constructor(private readonly name: string = SEARCH_DB_NAME) {}

  async load(): Promise<PersistedIndex | undefined> {
    const db = await this.#open();
    return await new Promise<PersistedIndex | undefined>((resolve, reject) => {
      const request = db.transaction(SEARCH_STORE, "readonly").objectStore(SEARCH_STORE).get(SEARCH_ENTRY_KEY);
      request.onsuccess = () => resolve((request.result as PersistedIndex | undefined) ?? undefined);
      request.onerror = () => reject(request.error ?? new Error("search index read failed"));
    });
  }

  async save(entry: PersistedIndex): Promise<void> {
    const db = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SEARCH_STORE, "readwrite");
      tx.objectStore(SEARCH_STORE).put(entry, SEARCH_ENTRY_KEY);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("search index write failed"));
    });
  }

  async clear(): Promise<void> {
    const db = await this.#open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SEARCH_STORE, "readwrite");
      tx.objectStore(SEARCH_STORE).delete(SEARCH_ENTRY_KEY);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("search index clear failed"));
    });
  }

  async close(): Promise<void> {
    const pending = this.#db;
    this.#db = undefined;
    if (pending) (await pending).close();
  }

  #open(): Promise<IDBDatabase> {
    this.#db ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is unavailable; pass MemorySearchPersistence instead"));
        return;
      }
      const request = indexedDB.open(this.name, SEARCH_DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(SEARCH_STORE)) {
          request.result.createObjectStore(SEARCH_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("search index database failed to open"));
    });
    return this.#db;
  }
}

// ---------------------------------------------------------------------------
// The index itself
// ---------------------------------------------------------------------------

/** One row as MiniSearch stores it. `fm` is flattened to its scalar leaves. */
interface IndexedDocument {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly fm: string;
  readonly deleted: boolean;
}

const INDEX_FIELDS = ["title", "content", "fm"] as const;

/** An in-progress streaming rebuild (see {@link MiniSearchIndex.beginRebuild}). */
export interface RebuildPass {
  add(rows: readonly ProjectionRow[]): void;
  /** Install the new index in place of the old one. */
  commit(): void;
}

/** MiniSearch construction options — `loadJSON` must be handed the same ones. */
function miniSearchOptions(): MiniSearchOptions<IndexedDocument> {
  return {
    idField: "id",
    fields: [...INDEX_FIELDS],
    storeFields: ["deleted"],
  };
}

/**
 * Flatten `fm` to searchable text: scalar leaves only, in key order, joined.
 *
 * Not a core-semantics reimplementation — nothing downstream depends on the
 * exact string, it only decides what a human can type to find a document. Keys
 * are left out so `status` does not match every document that has a status.
 */
function flattenForIndex(value: CoreValue, out: string[], depth = 0): void {
  if (depth > 6) return;
  if (value === null) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) flattenForIndex(item, out, depth + 1);
    return;
  }
  for (const key of Object.keys(value).sort()) {
    flattenForIndex((value as Record<string, CoreValue>)[key] as CoreValue, out, depth + 1);
  }
}

/** Project a row into the indexed document. Exported for the worker. */
export function indexDocument(row: ProjectionRow): IndexedDocument {
  const fm: string[] = [];
  flattenForIndex(row.fm, fm);
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? "",
    fm: fm.join(" "),
    deleted: row.deleted,
  };
}

/**
 * In-process MiniSearch implementation. The worker version
 * ({@link import("./worker-search.js").WorkerSearchIndex}) wraps this same class
 * behind a message port, which is where it runs in the app.
 */
export class MiniSearchIndex implements SearchIndex {
  #index: MiniSearch<IndexedDocument> | undefined;
  #safeSeq = 0;
  #builtAt: number | undefined;
  #bytes: number | undefined;
  readonly #persistence: SearchPersistence | undefined;

  constructor(options: { readonly persistence?: SearchPersistence } = {}) {
    this.#persistence = options.persistence;
  }

  async open(): Promise<void> {
    if (this.#index) return;
    const entry = await this.#persistence?.load().catch(() => undefined);
    if (entry && entry.version === SEARCH_INDEX_VERSION) {
      try {
        // The whole point of persistence: deserialize, never re-tokenize.
        this.#index = MiniSearch.loadJSON<IndexedDocument>(entry.index, miniSearchOptions());
        this.#safeSeq = entry.safeSeq;
        this.#builtAt = entry.builtAt;
        this.#bytes = entry.index.length;
        return;
      } catch {
        // A serialization format MiniSearch no longer accepts: start over.
        await this.#persistence?.clear().catch(() => undefined);
      }
    } else if (entry) {
      // SEARCH_INDEX_VERSION moved: the one sanctioned full rebuild.
      await this.#persistence?.clear().catch(() => undefined);
    }
    this.#index = new MiniSearch<IndexedDocument>(miniSearchOptions());
    this.#safeSeq = 0;
    this.#builtAt = undefined;
    this.#bytes = undefined;
  }

  async upsert(rows: readonly ProjectionRow[]): Promise<void> {
    const index = this.#require();
    for (const row of rows) {
      const document = indexDocument(row);
      if (index.has(row.id)) index.replace(document);
      else index.add(document);
    }
    return Promise.resolve();
  }

  async remove(ids: readonly string[]): Promise<void> {
    const index = this.#require();
    const present = ids.filter((id) => index.has(id));
    if (present.length > 0) index.discardAll(present);
    return Promise.resolve();
  }

  async search(query: string, options: SearchOptions = {}): Promise<readonly SearchHit[]> {
    const index = this.#require();
    const text = query.trim();
    if (text.length === 0) return [];
    const fields = options.fields ?? INDEX_FIELDS;
    const includeDeleted = options.includeDeleted ?? false;
    const results = index.search(text, {
      fields: [...fields],
      boost: { ...SEARCH_FIELDS },
      prefix: options.prefix ?? true,
      fuzzy: options.fuzzy ?? 0.2,
      filter: includeDeleted ? undefined : (result) => result["deleted"] !== true,
    });
    const limit = options.limit ?? results.length;
    return Promise.resolve(
      results.slice(0, Math.max(0, limit)).map((result) => ({
        id: String(result.id),
        score: result.score,
        terms: result.terms,
      })),
    );
  }

  async persist(safeSeq: number): Promise<void> {
    const index = this.#require();
    this.#safeSeq = safeSeq;
    this.#builtAt = Date.now();
    if (!this.#persistence) return;
    const serialized = JSON.stringify(index.toJSON());
    this.#bytes = serialized.length;
    await this.#persistence.save({
      version: SEARCH_INDEX_VERSION,
      safeSeq,
      builtAt: this.#builtAt,
      documents: index.documentCount,
      index: serialized,
    });
  }

  async stats(): Promise<SearchStats> {
    return Promise.resolve({
      documents: this.#index?.documentCount ?? 0,
      bytes: this.#bytes,
      builtAt: this.#builtAt,
      safeSeq: this.#safeSeq,
    });
  }

  async rebuild(rows: AsyncIterable<ProjectionRow>): Promise<void> {
    const pass = this.beginRebuild();
    let batch: ProjectionRow[] = [];
    for await (const row of rows) {
      batch.push(row);
      if (batch.length >= 500) {
        pass.add(batch);
        batch = [];
      }
    }
    if (batch.length > 0) pass.add(batch);
    pass.commit();
  }

  /**
   * Streaming rebuild: the worker feeds pages as they arrive over the port
   * instead of buffering the whole workspace to satisfy `rebuild`'s
   * `AsyncIterable`. The half-built index is invisible until `commit()`.
   */
  beginRebuild(): RebuildPass {
    const next = new MiniSearch<IndexedDocument>(miniSearchOptions());
    return {
      add: (rows) => next.addAll(rows.map(indexDocument)),
      commit: () => {
        this.#index = next;
        this.#safeSeq = 0;
        this.#builtAt = Date.now();
        this.#bytes = undefined;
      },
    };
  }

  async close(): Promise<void> {
    this.#index = undefined;
    await this.#persistence?.close?.().catch(() => undefined);
  }

  #require(): MiniSearch<IndexedDocument> {
    const index = this.#index;
    if (!index) throw new Error("search index is not open: call open() first");
    return index;
  }
}
