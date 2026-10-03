import type { ProjectionRow } from "../protocol.js";
import { loadCore, type CoreBindings } from "../wasm/index.js";
import { openSearchDatabase, type SqlRow } from "./database.js";
import { SearchProjection, type ProjectionStatus, type ProjectionSync } from "./projection.js";

export interface ProjectionBackend {
  open(): Promise<ProjectionStatus>;
  status(): Promise<ProjectionStatus>;
  sync(rows: readonly ProjectionRow[], first: boolean, last: boolean): Promise<number>;
  apply(rows: readonly ProjectionRow[], purged: readonly string[]): Promise<number>;
  select(sql: string): Promise<readonly SqlRow[]>;
  wipe(): Promise<void>;
}

export interface ProjectionHostOptions {
  readonly core?: CoreBindings;
  readonly persistent?: boolean;
}

export class ProjectionHost implements ProjectionBackend {
  #projection: Promise<SearchProjection> | undefined;
  #sync: ProjectionSync | undefined;

  constructor(private readonly options: ProjectionHostOptions = {}) {}

  async open(): Promise<ProjectionStatus> {
    return (await this.#open()).status();
  }

  async status(): Promise<ProjectionStatus> {
    return (await this.#open()).status();
  }

  async sync(rows: readonly ProjectionRow[], first: boolean, last: boolean): Promise<number> {
    const projection = await this.#open();
    if (first || !this.#sync) this.#sync = projection.beginSync();
    let changed = this.#sync.add(rows);
    if (last) {
      changed += this.#sync.commit();
      this.#sync = undefined;
    }
    return changed;
  }

  async apply(rows: readonly ProjectionRow[], purged: readonly string[]): Promise<number> {
    const projection = await this.#open();
    return projection.apply(rows) + projection.remove(purged);
  }

  async select(sql: string): Promise<readonly SqlRow[]> {
    return (await this.#open()).select(sql);
  }

  async wipe(): Promise<void> {
    const pending = this.#projection;
    this.#projection = undefined;
    this.#sync = undefined;
    if (pending) {
      await (await pending.catch(() => undefined))?.wipe();
      return;
    }
    const db = await openSearchDatabase({ persistent: this.options.persistent ?? true });
    await db.wipe();
  }

  close(): void {
    const pending = this.#projection;
    this.#projection = undefined;
    void pending?.then((projection) => projection.close()).catch(() => undefined);
  }

  #open(): Promise<SearchProjection> {
    this.#projection ??= (async () => {
      const core = this.options.core ?? (await loadCore());
      const db = await openSearchDatabase({ persistent: this.options.persistent ?? true });
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
