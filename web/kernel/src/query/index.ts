/**
 * The local query engine (SPEC §4.2): filter + sort + search + folder relations over
 * the projection store, with live-updating subscriptions. `documents.query` in the
 * `@kernel` surface is this, and the server's query endpoints exist for scripts and
 * backend plugins — the PWA does not browse through them.
 *
 * Every read is a {@link QueryPlan} answered by the shared core's query engine
 * (`EngineIndex`, in the query worker): the **same engine the server runs**, so a
 * list, a search and a folder filter answer identically online and offline. The
 * engine answers with ids; the rows come from the store.
 *
 * **FROZEN INTERFACE** (additive since kernel 3.1.0: `runPlan`, `subscribePlan`).
 */

import type { ProjectionRow } from "../protocol.js";
import type { ProjectionStore, StoreChange, StoredRow } from "../store/projection-store.js";
import type { CoreBindings } from "../wasm/index.js";
import { WasmFilterEvaluator, type FilterEvaluator, type Query, type QueryResult } from "./filter.js";
import { hasRelations, planOf, type PlanHit, type QueryPlan } from "./plan.js";
import { WasmEngineIndex, type EngineIndex, type SearchHit, type SearchOptions } from "./search.js";

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
  ALL_ROWS,
  hasRelations,
  planOf,
  sortToken,
  type PlanHit,
  type PlanPage,
  type PlanSnippet,
  type QueryPlan,
} from "./plan.js";
export {
  IdbSearchPersistence,
  MemorySearchPersistence,
  SEARCH_DB_NAME,
  SEARCH_DB_VERSION,
  SEARCH_ENTRY_KEY,
  SEARCH_INDEX_VERSION,
  SEARCH_STORE,
  WasmEngineIndex,
  type EngineIndex,
  type PersistedIndex,
  type RebuildPass,
  type SearchHit,
  type SearchIndex,
  type SearchOptions,
  type SearchPersistence,
  type SearchStats,
  type WasmEngineIndexOptions,
} from "./search.js";
export {
  WorkerSearchIndex,
  createSearchIndex,
  type WorkerSearchOptions,
} from "./worker-search.js";

/**
 * How often the engine is written back to IndexedDB while rows stream in. It is the
 * whole workspace, text included, so not after every batch.
 */
const PERSIST_DEBOUNCE_MS = 5_000;

/** A plan's answer, with its rows. */
export interface PlanResult {
  readonly rows: readonly ProjectionRow[];
  /** Every match, before paging. */
  readonly total: number;
  /** Present while there is another page: pass it back as the plan's `cursor`. */
  readonly nextCursor?: string;
  /** Why each row matched the plan's text; empty without text. */
  readonly hits: Readonly<Record<string, PlanHit>>;
}

/** A live query: current result plus a change notification. */
export interface Subscription<R = QueryResult> {
  readonly result: R;
  /** Called after every store change that alters the result. */
  onChange(listener: (result: R) => void): () => void;
  close(): void;
}

/**
 * One live query.
 *
 * The interesting part is {@link LiveQuery.apply}: a store change re-runs the
 * query only when it can actually alter the result — a touched row that is in the
 * result, a purge of one, or a changed row that now matches the filter (and so
 * changes at least `total`). Everything else is a batch about documents this
 * query does not care about.
 *
 * Two kinds of query cannot be judged row by row, and re-run on any change: text
 * (ranking is global — any row can reorder the hits) and folder relations (a
 * changed parent moves children it does not contain).
 */
class LiveQuery<R extends { readonly rows: readonly ProjectionRow[] }> implements Subscription<R> {
  #result: R;
  #ids: Set<string>;
  #closed = false;
  readonly #listeners = new Set<(result: R) => void>();

  constructor(
    initial: R,
    private readonly global: boolean,
    private readonly rerun: () => Promise<R>,
    private readonly candidate: (row: StoredRow) => boolean,
    private readonly onClose: (live: LiveQuery<R>) => void,
  ) {
    this.#result = initial;
    this.#ids = new Set(initial.rows.map((row) => row.id));
  }

  get result(): R {
    return this.#result;
  }

  get closed(): boolean {
    return this.#closed;
  }

  onChange(listener: (result: R) => void): () => void {
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
      relevant = this.global
        ? appliedRows.length > 0 || change.purged.length > 0
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

  readonly #index: EngineIndex;
  // Heterogeneous result types; each knows its own.
  readonly #live = new Set<LiveQuery<{ readonly rows: readonly ProjectionRow[] }>>();
  #unsubscribe: (() => void) | undefined;
  /** Live-query re-runs, one at a time, in arrival order. */
  #queue: Promise<void> = Promise.resolve();
  /** Engine writes, one at a time, in arrival order. */
  #indexQueue: Promise<void> = Promise.resolve();
  #indexOpened: Promise<void> | undefined;
  #persistTimer: ReturnType<typeof setTimeout> | undefined;
  #persistSeq = 0;
  #onError: ((error: Error) => void) | undefined;

  /**
   * `index` is the engine to answer with: the worker-backed one in a browser
   * (`createSearchIndex()`). Absent, an in-process engine over `core` (Node, tests).
   */
  constructor(
    private readonly store: ProjectionStore,
    core: CoreBindings,
    index?: EngineIndex,
  ) {
    this.filters = new WasmFilterEvaluator(core);
    this.#index = index ?? new WasmEngineIndex({ core });
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
    const { rows, total } = await this.runPlan(planOf(query));
    return { rows, total };
  }

  /** Live query: runs once, then re-runs on relevant store changes. */
  async subscribe(query: Query): Promise<Subscription> {
    return this.#live_(
      () => this.run(query),
      Boolean(query.search?.trim()) || hasRelations(query.filter),
      (row) => this.#candidate(row, query.filter, query.includeDeleted === true ? "all" : "live"),
    );
  }

  /** One-shot plan: rows, total, the next page's cursor and the text hits. Since 3.1.0. */
  async runPlan(plan: QueryPlan): Promise<PlanResult> {
    this.#attach();
    await this.#ensureIndex();
    const page = await this.#index.run(plan);
    const rows = await this.#rowsById(page.ids);
    const ordered: ProjectionRow[] = [];
    for (const id of page.ids) {
      const row = rows.get(id);
      if (row) ordered.push(row); // indexed but no longer stored: the next batch drops it
    }
    return {
      rows: ordered,
      total: page.total,
      ...(page.next_cursor !== undefined ? { nextCursor: page.next_cursor } : {}),
      hits: page.hits ?? {},
    };
  }

  /** Live plan: runs once, then re-runs on relevant store changes. Since 3.1.0. */
  async subscribePlan(plan: QueryPlan): Promise<Subscription<PlanResult>> {
    return this.#live_(
      () => this.runPlan(plan),
      Boolean(plan.text?.trim()) || hasRelations(plan.filter),
      (row) => this.#candidate(row, plan.filter, plan.trash ?? "live"),
    );
  }

  /** Full-text search, ranked, optionally intersected with a filter. */
  async searchDocuments(
    text: string,
    options: SearchOptions & { readonly filter?: Query["filter"] } = {},
  ): Promise<readonly SearchHit[]> {
    if (text.trim() === "") return [];
    this.#attach();
    await this.#ensureIndex();
    const page = await this.#index.run({
      text,
      ...(options.filter ? { filter: options.filter } : {}),
      sort: ["relevance"],
      trash: options.includeDeleted === true ? "all" : "live",
      limit: options.limit ?? 1_000_000,
    });
    return page.ids.map((id) => {
      const hit = page.hits?.[id];
      return { id, score: hit?.score ?? 0, terms: hit?.terms ?? [] };
    });
  }

  /** Single row by id, straight from the store. */
  get(id: string): Promise<ProjectionRow | undefined> {
    return this.store.get(id);
  }

  /** The engine every query is answered by. */
  get searchIndex(): EngineIndex {
    return this.#index;
  }

  /**
   * Bring the engine level with the store and start following it.
   *
   * Called for you by the first query; call it at start-up to get indexing going
   * before anything asks. Additive.
   */
  async warmUp(): Promise<void> {
    this.#attach();
    await this.#ensureIndex();
  }

  /**
   * Stop following the store: closes every live subscription's feed of changes
   * and stops indexing. The engine itself is persisted first. Additive.
   */
  async close(): Promise<void> {
    this.#detach();
    for (const live of [...this.#live]) live.close();
    if (this.#persistTimer !== undefined) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = undefined;
      await this.#index.persist(this.#persistSeq).catch(() => undefined);
    }
    this.#indexOpened = undefined;
  }

  // -------------------------------------------------------------------------
  // Querying
  // -------------------------------------------------------------------------

  async #live_<R extends { readonly rows: readonly ProjectionRow[] }>(
    run: () => Promise<R>,
    global: boolean,
    candidate: (row: StoredRow) => boolean,
  ): Promise<Subscription<R>> {
    this.#attach();
    const initial = await run();
    const live = new LiveQuery<R>(initial, global, run, candidate, (closed) => {
      this.#live.delete(closed as unknown as LiveQuery<{ readonly rows: readonly ProjectionRow[] }>);
    });
    this.#live.add(live as unknown as LiveQuery<{ readonly rows: readonly ProjectionRow[] }>);
    return live;
  }

  async #rowsById(ids: readonly string[]): Promise<Map<string, StoredRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.store.getMany(ids);
    return new Map(rows.map((row) => [row.id, row]));
  }

  /** Could this row belong to the result? (Cheap, no store access.) */
  #candidate(row: StoredRow, filter: Query["filter"], trash: "live" | "trashed" | "all"): boolean {
    if (trash === "live" && row.deleted) return false;
    if (trash === "trashed" && !row.deleted) return false;
    return filter ? this.filters.matches(filter, row) : true;
  }

  // -------------------------------------------------------------------------
  // Following the store
  // -------------------------------------------------------------------------

  /**
   * Follow the store (from the first query until `close()`): every change is written
   * to the engine, **then** every live
   * query it can affect re-runs.
   *
   * The order is the point. A live query is answered by the engine, so re-running it
   * before the engine has the change would answer from the old rows. Each change's
   * delivery therefore waits for that change's write — and only for that one: the
   * writes stay serialized in feed order on their own chain, the re-runs on theirs.
   */
  #attach(): void {
    this.#unsubscribe ??= this.store.subscribe((change) => {
      // One read, shared by both chains. It starts immediately rather than inside a
      // queue: the rows are already committed when `emit` fires (that is the store's
      // contract), so there is nothing to wait for.
      const applied = this.store.getMany(change.applied);
      applied.catch(() => undefined);

      const indexed = (this.#indexQueue = this.#indexQueue
        .then(async () => this.#write(change, await applied))
        .catch((error: unknown) => {
          this.#report(error);
        }));

      this.#queue = this.#queue
        .then(async () => {
          await indexed;
          await this.#deliver(change, await applied);
        })
        .catch((error: unknown) => {
          this.#report(error);
        });
    });
  }

  /**
   * Stop following the store — only on `close()`. The engine answers one-shot reads
   * too, so it follows the store from the first query on, live subscriptions or not.
   */
  #detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  /** Re-run every live query the change can affect. */
  async #deliver(change: StoreChange, applied: readonly StoredRow[]): Promise<void> {
    for (const live of [...this.#live]) {
      await live.apply(change, applied).catch((error: unknown) => this.#report(error));
    }
  }

  /**
   * Keep the engine level with the store.
   *
   * Only once it has been opened: until `#ensureIndex` has run, the rows in this
   * batch are above the watermark it will catch up from anyway.
   */
  async #write(change: StoreChange, applied: readonly StoredRow[]): Promise<void> {
    if (!this.#indexOpened) return;
    try {
      await this.#ensureIndex();
      await this.#index.upsert(applied);
      if (change.purged.length > 0) await this.#index.remove(change.purged);
      this.#schedulePersist(change.safeSeq);
    } catch (error) {
      this.#report(error);
    }
  }

  /**
   * Catch the engine up to the store, without a full rebuild.
   *
   * The persisted engine carries the watermark it reflects, so only rows the feed
   * moved since then are re-indexed: a warm start indexes nothing, and a cold one
   * indexes everything exactly once — in the worker, never on the main thread
   * (SPEC §4.2).
   */
  #ensureIndex(): Promise<void> {
    this.#indexOpened ??= (async () => {
      const index = this.#index;
      await index.open();
      const [stats, checkpoint] = await Promise.all([index.stats(), this.store.checkpoint()]);
      if (stats.safeSeq >= checkpoint.safeSeq && stats.safeSeq > 0) return;
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
      // Let the next call try again rather than wedging every query forever.
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
      void this.#index.persist(seq).catch((error: unknown) => this.#report(error));
    }, PERSIST_DEBOUNCE_MS);
    // Never hold a Node process open for a cache write (the harness runs here).
    (this.#persistTimer as unknown as { unref?: () => void }).unref?.();
  }

  #report(error: unknown): void {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (this.#onError) this.#onError(wrapped);
    else console.warn("[query]", wrapped.message);
  }
}
