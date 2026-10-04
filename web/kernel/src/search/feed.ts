import type { ProjectionStore, StoreChange, StoredRow } from "../store/projection-store.js";
import type { ProjectionBackend } from "./backend.js";
import type { SqlRow } from "./database.js";
import { serializeSearchError } from "./errors.js";
import type { PeerMessage, PeerOp, SearchPeers } from "./peers.js";
import type { Applied, ProjectionStatus, SearchRows } from "./projection.js";

export const PROJECTION_CHUNK = 250;

export interface ProjectionProgress {
  readonly done: number;
  readonly total: number;
}

export type ProjectionRole = "solo" | "owner" | "follower";

interface Pending {
  readonly op: PeerOp;
  readonly payload: unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

function remoteError(error: { readonly name: string; readonly message: string; readonly kind?: string } | undefined): Error {
  const out = new Error(error?.message ?? "the search owner failed");
  return Object.assign(out, { name: error?.name ?? "Error", ...(error?.kind ? { kind: error.kind } : {}) });
}

export class ProjectionFeed {
  readonly ready: Promise<ProjectionStatus>;

  #resolveReady!: (status: ProjectionStatus) => void;
  #rejectReady!: (error: Error) => void;
  #settled = false;
  #started = false;
  #building = true;
  #role: ProjectionRole;
  #unsubscribe: (() => void) | undefined;
  #unlisten: (() => void) | undefined;
  #queue: Promise<void> = Promise.resolve();
  #built: Promise<void> = Promise.resolve();
  #dormant = false;
  #building$: Promise<unknown> = Promise.resolve();
  #nextCall = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #held: StoreChange[] = [];
  readonly #progress = new Set<(progress: ProjectionProgress) => void>();
  readonly #errors = new Set<(error: Error) => void>();
  readonly #changes = new Set<(sources: ReadonlySet<string>) => void>();

  constructor(
    private readonly store: ProjectionStore,
    private readonly backend: ProjectionBackend,
    private readonly peers?: SearchPeers,
    private readonly options: { readonly persistent?: boolean } = {},
  ) {
    this.#role = peers ? "follower" : "solo";
    this.ready = new Promise<ProjectionStatus>((resolve, reject) => {
      this.#resolveReady = (status) => {
        this.#settled = true;
        resolve(status);
      };
      this.#rejectReady = (error) => {
        this.#settled = true;
        reject(error);
      };
    });
    this.ready.catch(() => undefined);
  }

  get role(): ProjectionRole {
    return this.#role;
  }

  start(): Promise<ProjectionStatus> {
    if (this.#started) return this.ready;
    this.#started = true;
    this.#unsubscribe = this.store.subscribe((change) => {
      if (this.#building && this.#role !== "follower") {
        this.#held.push(change);
        return;
      }
      this.#enqueue(() => this.#apply(change));
    });
    if (!this.peers) {
      this.#own();
      return this.ready;
    }
    const peers = this.peers;
    this.#unlisten = peers.onMessage((message) => this.#receive(message));
    void peers.claim().then((owned) => {
      if (owned) {
        this.#own();
        return;
      }
      this.#building = false;
      void peers.whenClaimed().then(() => this.#own());
      void this.#call("status", null).then(
        (status) => {
          if (!this.#settled) this.#resolveReady(status as ProjectionStatus);
        },
        () => undefined,
      );
    });
    return this.ready;
  }

  onProgress(listener: (progress: ProjectionProgress) => void): () => void {
    this.#progress.add(listener);
    return () => this.#progress.delete(listener);
  }

  onChange(listener: (sources: ReadonlySet<string>) => void): () => void {
    this.#changes.add(listener);
    return () => this.#changes.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#errors.add(listener);
    return () => this.#errors.delete(listener);
  }

  async settled(): Promise<ProjectionStatus> {
    await this.ready;
    await this.#building$;
    let queue: Promise<void>;
    do {
      queue = this.#queue;
      await queue;
    } while (queue !== this.#queue);
    return this.#role === "follower" ? ((await this.#call("status", null)) as ProjectionStatus) : this.backend.status();
  }

  async select(sql: string): Promise<readonly SqlRow[]> {
    await this.ready;
    await this.#built;
    this.#refuseWhileDormant();
    if (this.#role === "follower") return (await this.#call("select", sql)) as readonly SqlRow[];
    return this.backend.select(sql);
  }

  async run(plan: unknown): Promise<SearchRows> {
    await this.ready;
    await this.#built;
    this.#refuseWhileDormant();
    await this.#queue;
    if (this.#role === "follower") return (await this.#call("run", plan)) as SearchRows;
    return this.backend.run(plan);
  }

  async wipe(): Promise<void> {
    this.stop();
    if (this.#role === "follower") {
      await this.#call("wipe", null).catch(() => undefined);
      return;
    }
    await this.backend.wipe();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  close(): void {
    this.stop();
    this.#unlisten?.();
    this.#unlisten = undefined;
    for (const pending of this.#pending.values()) pending.reject(new Error("the search feed closed"));
    this.#pending.clear();
    this.peers?.close();
  }

  #refuseWhileDormant(): void {
    if (this.#dormant) {
      throw Object.assign(new Error("search starts again after you sign in"), { name: "SearchUnavailableError" });
    }
  }

  #own(): void {
    const wasFollower = this.#role === "follower";
    const answered = this.#settled;
    this.#role = this.peers ? "owner" : "solo";
    this.#building = true;
    const building = this.#build((reusable) => {
      if (!this.#settled) this.#resolveReady(reusable);
    });
    this.#building$ = building.catch(() => undefined);
    if (answered) {
      this.#built = building.then(
        () => undefined,
        () => undefined,
      );
    }
    void building.then(
      (status) => {
        if (!this.#settled) this.#resolveReady(status);
        if (this.peers) this.peers.post({ kind: "owner", id: this.peers.id });
        if (wasFollower) this.#replayPending();
      },
      (error: unknown) => {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        this.#report(wrapped);
        if (!this.#settled) this.#rejectReady(wrapped);
      },
    );
  }

  async #build(reusable: (status: ProjectionStatus) => void): Promise<ProjectionStatus> {
    const opened = await this.backend.open(this.options.persistent === false ? { persistent: false } : {});
    if (opened.persistent && opened.documents > 0) reusable(opened);
    const sources = new Set<string>();
    const total = await this.store.count({ includeDeleted: true });
    let done = 0;
    let first = true;
    let batch: StoredRow[] = [];
    this.#emit({ done, total });
    for await (const row of this.store.iterate({ includeDeleted: true })) {
      batch.push(row);
      if (batch.length >= PROJECTION_CHUNK) {
        for (const source of (await this.backend.sync(batch, first, false)).sources) sources.add(source);
        first = false;
        done += batch.length;
        batch = [];
        this.#emit({ done, total: Math.max(total, done) });
      }
    }
    for (const source of (await this.backend.sync(batch, first, true)).sources) sources.add(source);
    done += batch.length;
    this.#emit({ done, total: Math.max(total, done) });
    this.#building = false;
    for (const change of this.#held.splice(0)) this.#enqueue(() => this.#apply(change));
    await this.#queue;
    this.#announce([...sources]);
    return this.backend.status();
  }

  #announce(sources: readonly string[]): void {
    if (sources.length === 0) return;
    this.#changed(sources);
    if (this.#role === "owner") this.peers?.post({ kind: "changed", sources });
  }

  #changed(sources: readonly string[]): void {
    if (sources.length === 0) return;
    const set = new Set(sources);
    for (const listener of [...this.#changes]) listener(set);
  }

  async #apply(change: StoreChange): Promise<void> {
    if (this.#role === "follower") return;
    if (this.#dormant) {
      this.#dormant = false;
      this.backend.revive?.();
      this.#own();
      return;
    }
    const rows = change.applied.length > 0 ? await this.store.getMany(change.applied) : [];
    const present = new Set(rows.map((row) => row.id));
    const gone = [...change.purged, ...change.applied.filter((id) => !present.has(id))];
    const applied = await this.backend.apply(rows, gone);
    this.#announce(applied.sources);
  }

  #call(op: PeerOp, payload: unknown): Promise<unknown> {
    const peers = this.peers;
    if (!peers) return Promise.reject(new Error("no search peers"));
    return new Promise<unknown>((resolve, reject) => {
      const id = this.#nextCall++;
      this.#pending.set(id, { op, payload, resolve, reject });
      peers.post({ kind: "call", id, from: peers.id, op, payload });
    });
  }

  #replayPending(): void {
    const peers = this.peers;
    if (!peers) return;
    for (const [id, pending] of [...this.#pending]) {
      if (this.#role === "owner") {
        this.#pending.delete(id);
        void this.#serve(pending.op, pending.payload).then(pending.resolve, pending.reject);
      } else {
        peers.post({ kind: "call", id, from: peers.id, op: pending.op, payload: pending.payload });
      }
    }
  }

  async #serve(op: PeerOp, payload: unknown): Promise<unknown> {
    switch (op) {
      case "status":
        await this.ready;
        await this.#built;
        return this.backend.status();
      case "run":
        await this.ready;
        await this.#built;
        this.#refuseWhileDormant();
        await this.#queue;
        return this.backend.run(payload);
      case "select":
        await this.ready;
        await this.#built;
        this.#refuseWhileDormant();
        return this.backend.select(payload as string);
      case "apply": {
        const { rows, gone } = payload as { readonly rows: readonly StoredRow[]; readonly gone: readonly string[] };
        let applied: Applied = { changed: 0, sources: [] };
        const task = async (): Promise<void> => {
          applied = await this.backend.apply(rows, gone);
          this.#announce(applied.sources);
        };
        const done = this.#queue.then(task);
        this.#queue = done.catch((error: unknown) => {
          this.#report(error instanceof Error ? error : new Error(String(error)));
        });
        await done;
        return applied;
      }
      case "wipe":
        this.#dormant = true;
        await this.backend.wipe();
        return undefined;
    }
  }

  #receive(message: PeerMessage): void {
    const peers = this.peers;
    if (!peers) return;
    switch (message.kind) {
      case "call":
        if (this.#role !== "owner") return;
        void this.#serve(message.op, message.payload).then(
          (value) => peers.post({ kind: "reply", id: message.id, to: message.from, ok: true, value }),
          (error: unknown) =>
            peers.post({ kind: "reply", id: message.id, to: message.from, ok: false, error: serializeSearchError(error) }),
        );
        return;
      case "reply": {
        if (message.to !== peers.id) return;
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(remoteError(message.error));
        return;
      }
      case "changed":
        if (this.#role === "follower") this.#changed(message.sources);
        return;
      case "owner":
        if (this.#role === "follower") this.#replayPending();
        return;
    }
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
