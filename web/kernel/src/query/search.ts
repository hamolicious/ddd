/**
 * The local query engine's index: the shared core's `QueryEngine` (wasm), holding
 * every projection row, their full-text index and the folder tree (SPEC §4.2).
 *
 * The same engine the server answers with, so filtering, ranking, relations and
 * sorting agree online and offline by construction. It runs in a Web Worker
 * (`worker-search.ts` / `search-worker.ts`), **persisted and incrementally
 * updated** — a warm start loads the saved engine and indexes only what the feed
 * moved since, never a cold-start main-thread rebuild.
 *
 * **FROZEN INTERFACE** (additive since kernel 3.1.0: `run` replaced `search`).
 */

import type { ProjectionRow } from "../protocol.js";
import { loadCore, type CoreBindings, type CoreQueryEngine } from "../wasm/index.js";
import type { PlanPage, QueryPlan } from "./plan.js";

export interface SearchHit {
  readonly id: string;
  readonly score: number;
  /** The indexed terms it matched, for highlighting. */
  readonly terms: readonly string[];
}

/**
 * `kernel.documents.search` options. The engine always matches prefixes and near
 * misses over title, frontmatter and content, so `prefix`, `fuzzy` and `fields` are
 * accepted and ignored.
 */
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

export interface EngineIndex {
  /** Load a persisted engine, or start an empty one. */
  open(): Promise<void>;
  /** Add or replace rows. Called with every applied feed batch. */
  upsert(rows: readonly ProjectionRow[]): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  /** Answer a plan. Rejects on a malformed or refused plan. */
  run(plan: QueryPlan): Promise<PlanPage>;
  /** Persist the engine plus its watermark. */
  persist(safeSeq: number): Promise<void>;
  stats(): Promise<SearchStats>;
  /** Drop and rebuild from the store (only after `feed.reset`/schema change). */
  rebuild(rows: AsyncIterable<ProjectionRow>): Promise<void>;
  close(): Promise<void>;
}

/** The pre-3.1 name. */
export type SearchIndex = EngineIndex;

/** Bump when the persisted shape changes; a mismatch forces one rebuild. 2: the wasm engine. */
export const SEARCH_INDEX_VERSION = 2;

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
  /** The engine as `CoreQueryEngine.toJson()` wrote it. */
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
// The engine itself
// ---------------------------------------------------------------------------

/** An in-progress streaming rebuild (see {@link WasmEngineIndex.beginRebuild}). */
export interface RebuildPass {
  add(rows: readonly ProjectionRow[]): void;
  /** Install the new engine in place of the old one. */
  commit(): void;
}

export interface WasmEngineIndexOptions {
  readonly persistence?: SearchPersistence;
  /** The shared core; loaded on `open()` when absent (the worker's case). */
  readonly core?: CoreBindings;
}

/**
 * The engine, in this thread. The worker wraps this same class behind a message
 * port, which is where it runs in the app; Node and the tests use it directly.
 */
export class WasmEngineIndex implements EngineIndex {
  #engine: CoreQueryEngine | undefined;
  #core: CoreBindings | undefined;
  #safeSeq = 0;
  #builtAt: number | undefined;
  #bytes: number | undefined;
  readonly #persistence: SearchPersistence | undefined;

  constructor(options: WasmEngineIndexOptions = {}) {
    this.#persistence = options.persistence;
    this.#core = options.core;
  }

  async open(): Promise<void> {
    if (this.#engine) return;
    const core = (this.#core ??= await loadCore());
    const entry = await this.#persistence?.load().catch(() => undefined);
    if (entry && entry.version === SEARCH_INDEX_VERSION) {
      // The whole point of persistence: load, never re-index.
      const loaded = core.queryEngine(entry.index);
      if (loaded) {
        this.#engine = loaded;
        this.#safeSeq = entry.safeSeq;
        this.#builtAt = entry.builtAt;
        this.#bytes = entry.index.length;
        return;
      }
    }
    // Another version, or unreadable: the one sanctioned full rebuild.
    if (entry) await this.#persistence?.clear().catch(() => undefined);
    this.#engine = this.#fresh(core);
    this.#safeSeq = 0;
    this.#builtAt = undefined;
    this.#bytes = undefined;
  }

  async upsert(rows: readonly ProjectionRow[]): Promise<void> {
    if (rows.length > 0) this.#require().upsert(rows);
    return Promise.resolve();
  }

  async remove(ids: readonly string[]): Promise<void> {
    if (ids.length > 0) this.#require().remove(ids);
    return Promise.resolve();
  }

  async run(plan: QueryPlan): Promise<PlanPage> {
    return Promise.resolve(this.#require().run(plan));
  }

  async persist(safeSeq: number): Promise<void> {
    const engine = this.#require();
    this.#safeSeq = safeSeq;
    this.#builtAt = Date.now();
    if (!this.#persistence) return;
    const serialized = engine.toJson();
    this.#bytes = serialized.length;
    await this.#persistence.save({
      version: SEARCH_INDEX_VERSION,
      safeSeq,
      builtAt: this.#builtAt,
      documents: engine.size,
      index: serialized,
    });
  }

  async stats(): Promise<SearchStats> {
    return Promise.resolve({
      documents: this.#engine?.size ?? 0,
      bytes: this.#bytes,
      builtAt: this.#builtAt,
      safeSeq: this.#safeSeq,
    });
  }

  async rebuild(rows: AsyncIterable<ProjectionRow>): Promise<void> {
    await this.open();
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
   * Streaming rebuild: the worker feeds pages as they arrive over the port instead of
   * buffering the whole workspace. The half-built engine is invisible until `commit()`.
   */
  beginRebuild(): RebuildPass {
    const core = this.#core;
    if (!core) throw new Error("the query engine is not open: call open() first");
    const next = this.#fresh(core);
    return {
      add: (rows) => {
        next.upsert(rows);
      },
      commit: () => {
        this.#engine?.free();
        this.#engine = next;
        this.#safeSeq = 0;
        this.#builtAt = Date.now();
        this.#bytes = undefined;
      },
    };
  }

  async close(): Promise<void> {
    this.#engine?.free();
    this.#engine = undefined;
    await this.#persistence?.close?.().catch(() => undefined);
  }

  #fresh(core: CoreBindings): CoreQueryEngine {
    const engine = core.queryEngine();
    if (!engine) throw new Error("the shared core could not create a query engine");
    return engine;
  }

  #require(): CoreQueryEngine {
    const engine = this.#engine;
    if (!engine) throw new Error("the query engine is not open: call open() first");
    return engine;
  }
}
