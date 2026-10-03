import type { ProjectionStore, StoreChange, StoredRow } from "../store/projection-store.js";
import type { ProjectionBackend } from "./backend.js";
import type { SqlRow } from "./database.js";
import type { ProjectionStatus } from "./projection.js";

export const PROJECTION_CHUNK = 250;

export interface ProjectionProgress {
  readonly done: number;
  readonly total: number;
}

export class ProjectionFeed {
  readonly ready: Promise<ProjectionStatus>;

  #resolveReady!: (status: ProjectionStatus) => void;
  #rejectReady!: (error: Error) => void;
  #started = false;
  #building = true;
  #unsubscribe: (() => void) | undefined;
  #queue: Promise<void> = Promise.resolve();
  readonly #held: StoreChange[] = [];
  readonly #progress = new Set<(progress: ProjectionProgress) => void>();
  readonly #errors = new Set<(error: Error) => void>();

  constructor(
    private readonly store: ProjectionStore,
    private readonly backend: ProjectionBackend,
  ) {
    this.ready = new Promise<ProjectionStatus>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.ready.catch(() => undefined);
  }

  start(): Promise<ProjectionStatus> {
    if (this.#started) return this.ready;
    this.#started = true;
    this.#unsubscribe = this.store.subscribe((change) => {
      if (this.#building) {
        this.#held.push(change);
        return;
      }
      this.#enqueue(() => this.#apply(change));
    });
    void this.#build().then(
      (status) => this.#resolveReady(status),
      (error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.#report(wrapped);
        this.#rejectReady(wrapped);
      },
    );
    return this.ready;
  }

  onProgress(listener: (progress: ProjectionProgress) => void): () => void {
    this.#progress.add(listener);
    return () => this.#progress.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errors.add(listener);
    return () => this.#errors.delete(listener);
  }

  async settled(): Promise<ProjectionStatus> {
    await this.ready;
    let queue: Promise<void>;
    do {
      queue = this.#queue;
      await queue;
    } while (queue !== this.#queue);
    return this.backend.status();
  }

  async select(sql: string): Promise<readonly SqlRow[]> {
    await this.ready;
    return this.backend.select(sql);
  }

  async wipe(): Promise<void> {
    this.stop();
    await this.backend.wipe();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async #build(): Promise<ProjectionStatus> {
    await this.backend.open();
    const total = await this.store.count({ includeDeleted: true });
    let done = 0;
    let first = true;
    let batch: StoredRow[] = [];
    this.#emit({ done, total });
    for await (const row of this.store.iterate({ includeDeleted: true })) {
      batch.push(row);
      if (batch.length >= PROJECTION_CHUNK) {
        await this.backend.sync(batch, first, false);
        first = false;
        done += batch.length;
        batch = [];
        this.#emit({ done, total: Math.max(total, done) });
      }
    }
    await this.backend.sync(batch, first, true);
    done += batch.length;
    this.#emit({ done, total: Math.max(total, done) });
    this.#building = false;
    for (const change of this.#held.splice(0)) this.#enqueue(() => this.#apply(change));
    await this.#queue;
    return this.backend.status();
  }

  async #apply(change: StoreChange): Promise<void> {
    const rows = change.applied.length > 0 ? await this.store.getMany(change.applied) : [];
    const present = new Set(rows.map((row) => row.id));
    const gone = [...change.purged, ...change.applied.filter((id) => !present.has(id))];
    await this.backend.apply(rows, gone);
  }

  #enqueue(task: () => Promise<void>): void {
    this.#queue = this.#queue.then(task).catch((error: unknown) => {
      this.#report(error instanceof Error ? error : new Error(String(error)));
    });
  }

  #emit(progress: ProjectionProgress): void {
    for (const listener of [...this.#progress]) listener(progress);
  }

  #report(error: Error): void {
    if (this.#errors.size === 0) console.warn("[search] projection", error.message);
    for (const listener of [...this.#errors]) listener(error);
  }
}
