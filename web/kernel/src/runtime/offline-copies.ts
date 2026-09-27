/**
 * Every note editable offline (`docs/SYNC-DECISIONS.md` §7).
 *
 * The projection already holds every note's *text* on every device, which makes them
 * readable offline. Editing needs the note's CRDT state: typing into a blank document
 * that merely shares the id would merge in as a second copy of the text. So, while
 * online, this keeps a replica of every note in the `docs` store, fetched over REST
 * (`GET /documents/:id?format=crdt`) and merged into whatever the device already has,
 * so unsent edits are never touched.
 *
 * A replica remembers the row's `updated_at` it was fetched at; a note is fetched
 * again when its row moves on. Notes open on this device are skipped: they are live.
 */

import type { ProjectionStore } from "../store/projection-store.js";
import type { DocHydrator } from "../sync/doc-hydration.js";
import type { ApiFetch } from "./outbox.js";

/** Requests in flight at once. */
const CONCURRENCY = 2;
/** A note that keeps changing is fetched at most this often. */
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

  /** Follow the feed: a note that changed elsewhere is fetched again, a little later. */
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

  /** Fetch every note whose copy is missing or behind its row. */
  refresh(): Promise<void> {
    return this.#queue(() => this.#pass());
  }

  /** One pass at a time, in order. */
  #queue(pass: () => Promise<void>): Promise<void> {
    const run = this.#running.then(pass, pass);
    this.#running = run.catch(() => undefined);
    return run;
  }

  /** `ids` ⇒ only those notes (they changed); otherwise every note. */
  async #pass(ids?: readonly string[]): Promise<void> {
    if (!this.options.online()) return;
    const versions = new Map((await this.options.hydrator.replicas()).map((replica) => [replica.id, replica.version]));
    const stale: Array<{ id: string; version: string }> = [];
    const rows = ids ? await this.options.store.getMany(ids) : this.options.store.iterate({ includeDeleted: true });
    for await (const row of rows) {
      // A note made here and not sent yet has nothing on the server to fetch.
      if (row.local && row.seq === 0) continue;
      if (versions.get(row.id) !== row.updated_at) stale.push({ id: row.id, version: row.updated_at });
    }
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < stale.length && this.options.online()) {
        const { id, version } = stale[next++]!;
        await this.#fetch(id, version);
        // Background work: let the page answer the person between notes.
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
      // Gone, refused or offline: the next pass tries again.
    }
  }
}
