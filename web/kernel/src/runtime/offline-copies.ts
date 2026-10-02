import type { ProjectionStore } from "../store/projection-store.js";
import type { DocHydrator } from "../sync/doc-hydration.js";
import type { ApiFetch } from "./outbox.js";

const CONCURRENCY = 2;
const REFETCH_DEBOUNCE_MS = 5_000;

export interface OfflineCopiesOptions {
  readonly store: ProjectionStore;
  readonly hydrator: DocHydrator;
  readonly api: ApiFetch;
  readonly online: () => boolean;
}

export class OfflineCopies {
  #running: Promise<void> = Promise.resolve();
  readonly #dirty = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #unsubscribe: (() => void) | undefined;

  constructor(private readonly options: OfflineCopiesOptions) {}

  start(): void {
    this.#unsubscribe ??= this.options.store.subscribe((change) => {
      for (const id of change.applied) this.#dirty.add(id);
      if (this.#dirty.size === 0 || this.#timer !== undefined) return;
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        const ids = [...this.#dirty];
        this.#dirty.clear();
        void this.#queue(() => this.#pass(ids));
      }, REFETCH_DEBOUNCE_MS);
    });
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  refresh(): Promise<void> {
    return this.#queue(() => this.#pass());
  }

  #queue(pass: () => Promise<void>): Promise<void> {
    const run = this.#running.then(pass, pass);
    this.#running = run.catch(() => undefined);
    return run;
  }

  async #pass(ids?: readonly string[]): Promise<void> {
    if (!this.options.online()) return;
    const versions = new Map((await this.options.hydrator.replicas()).map((replica) => [replica.id, replica.version]));
    const stale: Array<{ id: string; version: string }> = [];
    const rows = ids ? await this.options.store.getMany(ids) : this.options.store.iterate({ includeDeleted: true });
    for await (const row of rows) {
      if (row.local && row.seq === 0) continue;
      if (versions.get(row.id) !== row.updated_at) stale.push({ id: row.id, version: row.updated_at });
    }
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < stale.length && this.options.online()) {
        const { id, version } = stale[next++]!;
        await this.#fetch(id, version);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

  async #fetch(id: string, version: string): Promise<void> {
    try {
      const response = await this.options.api(`/documents/${encodeURIComponent(id)}?format=crdt`, {
        headers: { accept: "application/octet-stream" },
      });
      await this.options.hydrator.absorb(id, new Uint8Array(await response.arrayBuffer()), version);
    } catch {
    }
  }
}
