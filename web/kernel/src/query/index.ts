/**
 * The local query engine (SPEC §4.2): filter + sort + search over the projection
 * store, with live-updating subscriptions. `documents.query` in M3's `@kernel`
 * surface is this, and the server's query endpoints exist for scripts and
 * backend plugins — the PWA does not browse through them.
 *
 * **FROZEN INTERFACE.**
 */

import type { ProjectionRow } from "../protocol.js";
import type { ProjectionStore, StoreChange, StoredRow } from "../store/projection-store.js";
import type { CoreBindings } from "../wasm/index.js";
import {
  WasmFilterEvaluator,
  compareRows,
  type FilterEvaluator,
  type Query,
  type QueryResult,
} from "./filter.js";
import type { SearchIndex, SearchOptions, SearchHit } from "./search.js";

export {
  compareRows,
  compareStrings,
  parseSortKey,
  resolvePath,
  WasmFilterEvaluator,
  type FilterEvaluator,
  type Query,
  type QueryResult,
  type SortDirection,
  type SortKey,
} from "./filter.js";
export {
  IdbSearchPersistence,
  MemorySearchPersistence,
  MiniSearchIndex,
  SEARCH_DB_NAME,
  SEARCH_DB_VERSION,
  SEARCH_ENTRY_KEY,
  SEARCH_FIELDS,
  SEARCH_INDEX_VERSION,
  SEARCH_STORE,
  indexDocument,
  type PersistedIndex,
  type RebuildPass,
  type SearchHit,
  type SearchIndex,
  type SearchOptions,
  type SearchPersistence,
  type SearchStats,
} from "./search.js";
export {
  WorkerSearchIndex,
  createSearchIndex,
  type WorkerSearchOptions,
} from "./worker-search.js";

/** How often the search index is written back to IndexedDB while rows stream in. */
const PERSIST_DEBOUNCE_MS = 2_000;

/** A live query: current result plus a change notification. */
export interface Subscription {
  readonly result: QueryResult;
  /** Called after every store change that alters the result. */
  onChange(listener: (result: QueryResult) => void): () => void;
  close(): void;
}

/**
 * One live query.
 *
 * The interesting part is {@link LiveQuery.apply}: a store change re-runs the
 * query only when it can actually alter the result — a touched row that is in the
 * result, a purge of one, or a changed row that now matches the filter (and so
 * changes at least `total`). Everything else is a batch about documents this
 * query does not care about, and a 5 000-row rescan per feed batch is exactly
 * what SPEC §9 M2's gate would fail on.
 */
class LiveQuery implements Subscription {
  #result: QueryResult;
  #ids: Set<string>;
  #closed = false;
  readonly #listeners = new Set<(result: QueryResult) => void>();

  constructor(
    readonly query: Query,
    initial: QueryResult,
    private readonly rerun: () => Promise<QueryResult>,
    private readonly candidate: (row: StoredRow) => boolean,
    private readonly onClose: (live: LiveQuery) => void,
  ) {
    this.#result = initial;
    this.#ids = new Set(initial.rows.map((row) => row.id));
  }

  get result(): QueryResult {
    return this.#result;
  }

  get closed(): boolean {
    return this.#closed;
  }

  onChange(listener: (result: QueryResult) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.onClose(this);
  }

  /** Decide whether `change` can alter this result, and re-emit if it can. */
  async apply(change: StoreChange, appliedRows: readonly StoredRow[]): Promise<void> {
    if (this.#closed) return;
    let relevant =
      change.purged.some((id) => this.#ids.has(id)) ||
      change.applied.some((id) => this.#ids.has(id));
    if (!relevant) {
      relevant = this.query.search
        ? // Ranking is global: any new or changed row can reorder a search result.
          appliedRows.length > 0
        : appliedRows.some((row) => this.candidate(row));
    }
    if (!relevant) return;
    const next = await this.rerun();
    if (this.#closed) return;
    this.#result = next;
    this.#ids = new Set(next.rows.map((row) => row.id));
    for (const listener of [...this.#listeners]) listener(next);
  }
}

export class QueryEngine {
  readonly filters: FilterEvaluator;

  readonly #live = new Set<LiveQuery>();
  #unsubscribe: (() => void) | undefined;
  /** Store changes are handled one at a time, in arrival order. */
  #queue: Promise<void> = Promise.resolve();
  #indexOpened: Promise<void> | undefined;
  #persistTimer: ReturnType<typeof setTimeout> | undefined;
  #persistSeq = 0;
  #onError: ((error: Error) => void) | undefined;

  constructor(
    private readonly store: ProjectionStore,
    core: CoreBindings,
    private readonly search?: SearchIndex,
  ) {
    this.filters = new WasmFilterEvaluator(core);
  }

  /**
   * Report background failures (index writes, live re-runs) instead of dropping
   * them on the floor. Additive; the demo wires it to its log line.
   */
  onError(listener: (error: Error) => void): void {
    this.#onError = listener;
  }

  /** One-shot query. */
  async run(query: Query): Promise<QueryResult> {
    const rows = await this.#matching(query);
    return page(rows, query);
  }

  /** Live query: runs once, then re-runs on relevant store changes. */
  async subscribe(query: Query): Promise<Subscription> {
    const initial = await this.run(query);
    const live = new LiveQuery(
      query,
      initial,
      () => this.run(query),
      (row) => this.#candidate(query, row),
      (closed) => {
        this.#live.delete(closed);
        if (this.#live.size === 0) this.#detach();
      },
    );
    this.#live.add(live);
    this.#attach();
    return live;
  }

  /** Full-text search, ranked, optionally intersected with a filter. */
  async searchDocuments(
    text: string,
    options: SearchOptions & { readonly filter?: Query["filter"] } = {},
  ): Promise<readonly SearchHit[]> {
    const index = this.#requireSearch();
    await this.#ensureIndex();
    const hits = await index.search(text, options);
    if (!options.filter) return hits;
    const rows = await this.#rowsById(hits.map((hit) => hit.id));
    const filter = options.filter;
    return hits.filter((hit) => {
      const row = rows.get(hit.id);
      return row !== undefined && this.filters.matches(filter, row);
    });
  }

  /** Single row by id, straight from the store. */
  get(id: string): Promise<ProjectionRow | undefined> {
    return this.store.get(id);
  }

  /** The search index, when one is wired (M3 worker). */
  get searchIndex(): SearchIndex | undefined {
    return this.search;
  }

  /**
   * Bring the search index level with the store and start following it.
   *
   * Called for you by the first search; call it at start-up to get indexing
   * going before the user types. Additive.
   */
  async warmUp(): Promise<void> {
    this.#attach();
    if (this.search) await this.#ensureIndex();
  }

  /**
   * Stop following the store: closes every live subscription's feed of changes
   * and stops indexing. The index itself is persisted first. Additive.
   */
  async close(): Promise<void> {
    this.#detach();
    for (const live of [...this.#live]) live.close();
    if (this.#persistTimer !== undefined) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = undefined;
      if (this.search) await this.search.persist(this.#persistSeq).catch(() => undefined);
    }
    this.#indexOpened = undefined;
  }

  // -------------------------------------------------------------------------
  // Querying
  // -------------------------------------------------------------------------

  /** Every matching row, sorted, before paging. */
  async #matching(query: Query): Promise<ProjectionRow[]> {
    const text = query.search?.trim();
    const rows = text ? await this.#searchRows(text, query) : await this.#scanRows(query);
    const sort = query.sort ?? [];
    if (sort.length > 0) {
      rows.sort((a, b) => compareRows(a, b, sort));
    } else if (!text) {
      // No sort key: `compare_rows` falls through to `id` ascending, which is the
      // server's implicit tiebreaker and the only deterministic default.
      rows.sort((a, b) => compareRows(a, b, []));
    }
    return rows;
  }

  async #scanRows(query: Query): Promise<ProjectionRow[]> {
    const rows: ProjectionRow[] = [];
    const filter = query.filter;
    for await (const row of this.store.iterate({ includeDeleted: query.includeDeleted ?? false })) {
      if (!filter || this.filters.matches(filter, row)) rows.push(row);
    }
    return rows;
  }

  /** Search-ordered rows: hit order is preserved unless the query names a sort. */
  async #searchRows(text: string, query: Query): Promise<ProjectionRow[]> {
    const index = this.#requireSearch();
    await this.#ensureIndex();
    const hits = await index.search(text, { includeDeleted: query.includeDeleted ?? false });
    const rows = await this.#rowsById(hits.map((hit) => hit.id));
    const out: ProjectionRow[] = [];
    for (const hit of hits) {
      const row = rows.get(hit.id);
      if (!row) continue; // indexed but no longer stored: the next persist drops it
      if (!query.includeDeleted && row.deleted) continue;
      if (query.filter && !this.filters.matches(query.filter, row)) continue;
      out.push(row);
    }
    return out;
  }

  async #rowsById(ids: readonly string[]): Promise<Map<string, StoredRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.store.getMany(ids);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Could this row belong to the result of `query`? (Cheap, no store access.) */
  #candidate(query: Query, row: StoredRow): boolean {
    if (row.deleted && !(query.includeDeleted ?? false)) return false;
    return query.filter ? this.filters.matches(query.filter, row) : true;
  }

  // -------------------------------------------------------------------------
  // Following the store
  // -------------------------------------------------------------------------

  #attach(): void {
    this.#unsubscribe ??= this.store.subscribe((change) => {
      this.#queue = this.#queue.then(() => this.#onChange(change)).catch((error: unknown) => {
        this.#report(error);
      });
    });
  }

  #detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async #onChange(change: StoreChange): Promise<void> {
    const applied = await this.store.getMany(change.applied);
    // Only index once someone has asked for search: until `#ensureIndex` has run,
    // the index is not open, and the rows in this batch are below the watermark it
    // will catch up from anyway.
    if (this.search && this.#indexOpened) {
      try {
        await this.#ensureIndex();
        await this.search.upsert(applied);
        if (change.purged.length > 0) await this.search.remove(change.purged);
        this.#schedulePersist(change.safeSeq);
      } catch (error) {
        this.#report(error);
      }
    }
    for (const live of [...this.#live]) {
      await live.apply(change, applied).catch((error: unknown) => this.#report(error));
    }
  }

  /**
   * Catch the index up to the store, without a full rebuild.
   *
   * The persisted index carries the watermark it reflects, so only rows the feed
   * moved since then are re-indexed: a warm start indexes nothing, and a cold one
   * indexes everything exactly once — in the worker, never on the main thread
   * (SPEC §4.2).
   */
  #ensureIndex(): Promise<void> {
    this.#indexOpened ??= (async () => {
      const index = this.#requireSearch();
      await index.open();
      const [stats, checkpoint] = await Promise.all([index.stats(), this.store.checkpoint()]);
      if (stats.safeSeq >= checkpoint.safeSeq) return;
      let batch: StoredRow[] = [];
      let indexed = 0;
      for await (const row of this.store.iterate({ includeDeleted: true })) {
        if (row.seq <= stats.safeSeq) continue;
        batch.push(row);
        if (batch.length >= 250) {
          await index.upsert(batch);
          indexed += batch.length;
          batch = [];
        }
      }
      if (batch.length > 0) {
        await index.upsert(batch);
        indexed += batch.length;
      }
      if (indexed > 0 || stats.safeSeq === 0) await index.persist(checkpoint.safeSeq);
    })().catch((error: unknown) => {
      // Let the next call try again rather than wedging search forever.
      this.#indexOpened = undefined;
      throw error instanceof Error ? error : new Error(String(error));
    });
    return this.#indexOpened;
  }

  #schedulePersist(safeSeq: number): void {
    this.#persistSeq = Math.max(this.#persistSeq, safeSeq);
    if (this.#persistTimer !== undefined) return;
    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = undefined;
      const seq = this.#persistSeq;
      void this.search?.persist(seq).catch((error: unknown) => this.#report(error));
    }, PERSIST_DEBOUNCE_MS);
    // Never hold a Node process open for a cache write (the harness runs here).
    (this.#persistTimer as unknown as { unref?: () => void }).unref?.();
  }

  #requireSearch(): SearchIndex {
    const index = this.search;
    if (!index) {
      throw new Error(
        "no search index is wired: construct QueryEngine with one (createSearchIndex())",
      );
    }
    return index;
  }

  #report(error: unknown): void {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (this.#onError) this.#onError(wrapped);
    else console.warn("[query]", wrapped.message);
  }
}

/** Apply `offset`/`limit` and report the pre-paging total. */
function page(rows: readonly ProjectionRow[], query: Query): QueryResult {
  const offset = Math.max(0, query.offset ?? 0);
  const limit = query.limit ?? rows.length - offset;
  return {
    rows: rows.slice(offset, offset + Math.max(0, limit)),
    total: rows.length,
  };
}
