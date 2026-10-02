import type { ProjectionRow } from "../protocol.js";
import { loadCore, type CoreBindings, type CoreQueryEngine } from "../wasm/index.js";
import type { PlanPage, QueryPlan } from "./plan.js";

export interface SearchHit {
  readonly id: string;
  readonly score: number;
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
  readonly bytes?: number;
  readonly builtAt?: number;
  readonly safeSeq: number;
}

export interface EngineIndex {
  open(): Promise<void>;
  upsert(rows: readonly ProjectionRow[]): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
  run(plan: QueryPlan): Promise<PlanPage>;
  persist(safeSeq: number): Promise<void>;
  stats(): Promise<SearchStats>;
  rebuild(rows: AsyncIterable<ProjectionRow>): Promise<void>;
  close(): Promise<void>;
}

export type SearchIndex = EngineIndex;

export const SEARCH_INDEX_VERSION = 2;

export interface PersistedIndex {
  readonly version: number;
  readonly safeSeq: number;
  readonly builtAt: number;
  readonly documents: number;
  readonly index: string;
}

export interface SearchPersistence {
  load(): Promise<PersistedIndex | undefined>;
  save(entry: PersistedIndex): Promise<void>;
  clear(): Promise<void>;
  close?(): Promise<void>;
}

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

export const SEARCH_DB_NAME = "ddd-search";
export const SEARCH_DB_VERSION = 1;
export const SEARCH_STORE = "index";
export const SEARCH_ENTRY_KEY = "projection";

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

export interface RebuildPass {
  add(rows: readonly ProjectionRow[]): void;
  commit(): void;
}

export interface WasmEngineIndexOptions {
  readonly persistence?: SearchPersistence;
  readonly core?: CoreBindings;
}

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
      const loaded = core.queryEngine(entry.index);
      if (loaded) {
        this.#engine = loaded;
        this.#safeSeq = entry.safeSeq;
        this.#builtAt = entry.builtAt;
        this.#bytes = entry.index.length;
        return;
      }
    }
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
