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

const PERSIST_DEBOUNCE_MS = 5_000;

export interface PlanResult {
  readonly rows: readonly ProjectionRow[];
  readonly total: number;
  readonly nextCursor?: string;
  readonly hits: Readonly<Record<string, PlanHit>>;
}

export interface Subscription<R = QueryResult> {
  readonly result: R;
  onChange(listener: (result: R) => void): () => void;
  close(): void;
}

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
  readonly #live = new Set<LiveQuery<{ readonly rows: readonly ProjectionRow[] }>>();
  #unsubscribe: (() => void) | undefined;
  #queue: Promise<void> = Promise.resolve();
  #indexQueue: Promise<void> = Promise.resolve();
  #indexOpened: Promise<void> | undefined;
  #persistTimer: ReturnType<typeof setTimeout> | undefined;
  #persistSeq = 0;
  #onError: ((error: Error) => void) | undefined;

  constructor(
    private readonly store: ProjectionStore,
    core: CoreBindings,
    index?: EngineIndex,
  ) {
    this.filters = new WasmFilterEvaluator(core);
    this.#index = index ?? new WasmEngineIndex({ core });
  }

  onError(listener: (error: Error) => void): void {
    this.#onError = listener;
  }

  async run(query: Query): Promise<QueryResult> {
    const { rows, total } = await this.runPlan(planOf(query));
    return { rows, total };
  }

  async subscribe(query: Query): Promise<Subscription> {
    return this.#live_(
      () => this.run(query),
      Boolean(query.search?.trim()) || hasRelations(query.filter),
      (row) => this.#candidate(row, query.filter, query.includeDeleted === true ? "all" : "live"),
    );
  }

  async runPlan(plan: QueryPlan): Promise<PlanResult> {
    this.#attach();
    await this.#ensureIndex();
    const page = await this.#index.run(plan);
    const rows = await this.#rowsById(page.ids);
    const ordered: ProjectionRow[] = [];
    for (const id of page.ids) {
      const row = rows.get(id);
      if (row) ordered.push(row);
    }
    return {
      rows: ordered,
      total: page.total,
      ...(page.next_cursor !== undefined ? { nextCursor: page.next_cursor } : {}),
      hits: page.hits ?? {},
    };
  }

  async subscribePlan(plan: QueryPlan): Promise<Subscription<PlanResult>> {
    return this.#live_(
      () => this.runPlan(plan),
      Boolean(plan.text?.trim()) || hasRelations(plan.filter),
      (row) => this.#candidate(row, plan.filter, plan.trash ?? "live"),
    );
  }

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

  get(id: string): Promise<ProjectionRow | undefined> {
    return this.store.get(id);
  }

  get searchIndex(): EngineIndex {
    return this.#index;
  }

  async warmUp(): Promise<void> {
    this.#attach();
    await this.#ensureIndex();
  }

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

  #candidate(row: StoredRow, filter: Query["filter"], trash: "live" | "trashed" | "all"): boolean {
    if (trash === "live" && row.deleted) return false;
    if (trash === "trashed" && !row.deleted) return false;
    return filter ? this.filters.matches(filter, row) : true;
  }

  #attach(): void {
    this.#unsubscribe ??= this.store.subscribe((change) => {
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

  #detach(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async #deliver(change: StoreChange, applied: readonly StoredRow[]): Promise<void> {
    for (const live of [...this.#live]) {
      await live.apply(change, applied).catch((error: unknown) => this.#report(error));
    }
  }

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
    (this.#persistTimer as unknown as { unref?: () => void }).unref?.();
  }

  #report(error: unknown): void {
    const wrapped = error instanceof Error ? error : new Error(String(error));
    if (this.#onError) this.#onError(wrapped);
    else console.warn("[query]", wrapped.message);
  }
}
