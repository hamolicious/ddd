import type { ProjectionRow } from "../protocol.js";
import type { CoreBindings } from "../wasm/index.js";
import type { PlanPage, QueryPlan } from "./plan.js";
import { WasmEngineIndex, type EngineIndex, type SearchStats } from "./search.js";
import type {
  SearchRequest,
  SearchRequestEnvelope,
  SearchResponseEnvelope,
} from "./search-protocol.js";

const REBUILD_CHUNK = 250;

export interface WorkerSearchOptions {
  readonly workerFactory?: () => Worker;
}

export class WorkerSearchIndex implements EngineIndex {
  #worker: Worker | undefined;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(private readonly options: WorkerSearchOptions = {}) {}

  async open(): Promise<void> {
    await this.#call({ op: "open" });
  }

  async upsert(rows: readonly ProjectionRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.#call({ op: "upsert", rows });
  }

  async remove(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.#call({ op: "remove", ids });
  }

  async run(plan: QueryPlan): Promise<PlanPage> {
    return (await this.#call({ op: "run", plan })) as PlanPage;
  }

  async persist(safeSeq: number): Promise<void> {
    await this.#call({ op: "persist", safeSeq });
  }

  async stats(): Promise<SearchStats> {
    return (await this.#call({ op: "stats" })) as SearchStats;
  }

  async rebuild(rows: AsyncIterable<ProjectionRow>): Promise<void> {
    let batch: ProjectionRow[] = [];
    let first = true;
    for await (const row of rows) {
      batch.push(row);
      if (batch.length >= REBUILD_CHUNK) {
        await this.#call({ op: "rebuild", rows: batch, first, last: false });
        first = false;
        batch = [];
      }
    }
    await this.#call({ op: "rebuild", rows: batch, first, last: true });
  }

  async close(): Promise<void> {
    const worker = this.#worker;
    if (!worker) return;
    try {
      await this.#call({ op: "close" });
    } catch {
    }
    this.#worker = undefined;
    for (const { reject } of this.#pending.values()) reject(new Error("search worker closed"));
    this.#pending.clear();
    worker.terminate();
  }

  #call(request: SearchRequest): Promise<unknown> {
    const worker = this.#ensureWorker();
    const id = this.#nextId++;
    const envelope: SearchRequestEnvelope = { id, request };
    return new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      worker.postMessage(envelope);
    });
  }

  #ensureWorker(): Worker {
    if (this.#worker) return this.#worker;
    const worker = (this.options.workerFactory ?? defaultWorkerFactory)();
    worker.addEventListener("message", (event: MessageEvent) => {
      const response = event.data as SearchResponseEnvelope;
      if (typeof response?.id !== "number") return;
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      this.#pending.delete(response.id);
      if (response.ok) pending.resolve(response.value);
      else pending.reject(new Error(response.error));
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      const error = new Error(`search worker failed: ${event.message}`);
      for (const { reject } of this.#pending.values()) reject(error);
      this.#pending.clear();
    });
    this.#worker = worker;
    return worker;
  }
}

function defaultWorkerFactory(): Worker {
  return new Worker(new URL("./search-worker.ts", import.meta.url), {
    type: "module",
    name: "ddd-search",
  });
}

export function createSearchIndex(
  options: WorkerSearchOptions & { readonly core?: CoreBindings } = {},
): EngineIndex {
  if (options.workerFactory || typeof Worker !== "undefined") {
    return new WorkerSearchIndex(options);
  }
  return new WasmEngineIndex(options.core ? { core: options.core } : {});
}
