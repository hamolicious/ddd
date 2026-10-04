import type { ProjectionRow } from "../protocol.js";
import { loadCore, type CoreBindings } from "../wasm/index.js";
import { openSearchDatabase, type SqlRow } from "./database.js";
import {
  NOTHING,
  SearchProjection,
  type Applied,
  type ProjectionStatus,
  type ProjectionSync,
  type SearchRows,
} from "./projection.js";

export interface ProjectionBackend {
  open(options?: { readonly persistent?: boolean }): Promise<ProjectionStatus>;
  revive?(): void;
  status(): Promise<ProjectionStatus>;
  sync(rows: readonly ProjectionRow[], first: boolean, last: boolean): Promise<Applied>;
  apply(rows: readonly ProjectionRow[], purged: readonly string[]): Promise<Applied>;
  select(sql: string): Promise<readonly SqlRow[]>;
  run(plan: unknown): Promise<SearchRows>;
  wipe(): Promise<void>;
}

export interface ProjectionHostOptions {
  readonly core?: CoreBindings;
  readonly persistent?: boolean;
}

export class ProjectionHost implements ProjectionBackend {
  #projection: Promise<SearchProjection> | undefined;
  #wiped = false;
  #sync: ProjectionSync | undefined;

  constructor(private readonly options: ProjectionHostOptions = {}) {}

  #persistent: boolean | undefined;

  revive(): void {
    this.#wiped = false;
  }

  async open(options: { readonly persistent?: boolean } = {}): Promise<ProjectionStatus> {
    if (options.persistent === false && this.#projection === undefined) this.#persistent = false;
    return (await this.#open()).status();
  }

  async status(): Promise<ProjectionStatus> {
    return (await this.#open()).status();
  }

  async sync(rows: readonly ProjectionRow[], first: boolean, last: boolean): Promise<Applied> {
    const projection = await this.#open();
    if (first || !this.#sync) this.#sync = projection.beginSync();
    const added = this.#sync.add(rows);
    if (!last) return added;
    const committed = this.#sync.commit();
    this.#sync = undefined;
    return { changed: added.changed + committed.changed, sources: [...new Set([...added.sources, ...committed.sources])] };
  }

  async apply(rows: readonly ProjectionRow[], purged: readonly string[]): Promise<Applied> {
    const projection = await this.#open();
    const applied = projection.apply(rows);
    const removed = purged.length > 0 ? projection.remove(purged) : NOTHING;
    return { changed: applied.changed + removed.changed, sources: [...new Set([...applied.sources, ...removed.sources])] };
  }

  async select(sql: string): Promise<readonly SqlRow[]> {
    return (await this.#open()).select(sql);
  }

  async run(plan: unknown): Promise<SearchRows> {
    return (await this.#open()).run(plan);
  }

  async wipe(): Promise<void> {
    this.#wiped = true;
    const pending = this.#projection;
    this.#projection = undefined;
    this.#sync = undefined;
    if (pending) {
      await (await pending.catch(() => undefined))?.wipe();
      return;
    }
    const db = await openSearchDatabase({ persistent: this.#persistent ?? this.options.persistent ?? true });
    await db.wipe();
  }

  close(): void {
    const pending = this.#projection;
    this.#projection = undefined;
    void pending?.then((projection) => projection.close()).catch(() => undefined);
  }

  #open(): Promise<SearchProjection> {
    if (this.#wiped) return Promise.reject(new Error("the search database was deleted at sign-out"));
    this.#projection ??= (async () => {
      const core = this.options.core ?? (await loadCore());
      const db = await openSearchDatabase({ persistent: this.#persistent ?? this.options.persistent ?? true });
      const projection = new SearchProjection(core, db);
      await projection.open();
      return projection;
    })().catch((error: unknown) => {
      this.#projection = undefined;
      throw error instanceof Error ? error : new Error(String(error));
    });
    return this.#projection;
  }
}
