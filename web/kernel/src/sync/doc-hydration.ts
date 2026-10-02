import * as Y from "yjs";

import {
  FrameType,
  encodeHistory,
  type BinaryFrame,
  type DocError,
  type DocResync,
  type DocSubscribed,
} from "../protocol.js";
import type { SyncTransport } from "./transport.js";

export const DEFAULT_LRU_SIZE = 20;

export const TEXT_ROOT = "content";

const REFUSED_RETRY_MS = 1_500;
const REFUSED_VERIFY_MS = 1_000;

function coversVector(theirs: Uint8Array, ours: Uint8Array): boolean {
  const server = Y.decodeStateVector(theirs);
  for (const [client, clock] of Y.decodeStateVector(ours)) {
    if ((server.get(client) ?? 0) < clock) return false;
  }
  return true;
}

export const JOURNAL_MERGE_MS = 2_000;

export const TAB_ID: string =
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `tab-${Math.random().toString(36).slice(2)}`;

export interface JournalEntry {
  readonly origin?: string;
  readonly at: number;
  readonly lastAt: number;
  readonly update: Uint8Array;
}

export const PERSIST_DEBOUNCE_MS = 500;

export const DEFAULT_PERSISTED_REPLICAS = 50;

export const SYNC_TIMEOUT_MS = 15_000;

export type DocPhase = "hydrating" | "live" | "error" | "released";

export interface HydratedDoc {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly phase: DocPhase;
  onAwareness(listener: (payload: Uint8Array) => void): () => void;
  sendAwareness(payload: Uint8Array): void;
  release(): void;
}

export interface DocHydratorOptions {
  readonly lruSize?: number;
  readonly persistence?: DocPersistence;
  readonly persistedReplicas?: number;
  readonly onError?: (id: string, error: DocError) => void;
  readonly onRefusalCleared?: (id: string) => void;
  readonly onLocalEdit?: (id: string, text: string) => void;
  readonly onOfflineEditsSent?: (id: string) => void;
  readonly persistDebounceMs?: number;
  readonly syncTimeoutMs?: number;
  readonly onPending?: (pending: number) => void;
  readonly onReplicaDiscarded?: (info: {
    readonly id: string;
    readonly hadUnsyncedEdits: boolean;
    readonly text: string;
  }) => void;
  readonly restBaseUrl?: string;
  readonly bearerToken?: string;
  readonly fetchImpl?: typeof fetch;
}

export interface DocReplicaMeta {
  readonly unsynced: boolean;
  readonly journal?: readonly JournalEntry[];
}

export interface StoredReplica extends Partial<DocReplicaMeta> {
  readonly state: Uint8Array;
}

export interface DocPersistence {
  load(id: string): Promise<Uint8Array | undefined>;
  save(id: string, state: Uint8Array, meta?: DocReplicaMeta): Promise<void>;
  drop(id: string): Promise<void>;
  prune(keep: number): Promise<string[]>;
  peek?(id: string): Promise<StoredReplica | undefined>;
  absorb?(id: string, state: Uint8Array, version: string): Promise<void>;
  list?(): Promise<Array<{ id: string; unsynced: boolean; version?: string }>>;
}

const REMOTE_ORIGIN = Symbol("ddd:remote");
const RESTORE_ORIGIN = Symbol("ddd:restore");

class DocEntry implements HydratedDoc {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  phase: DocPhase = "hydrating";
  refs = 0;
  subscribed = false;
  synced = false;
  acked = false;
  journal: JournalEntry[] = [];
  pending = 0;
  refused = false;
  retryPending = false;
  verifyOnly = false;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  dirty = false;
  hasLocalState = false;
  persistTimer: ReturnType<typeof setTimeout> | undefined;
  readonly awarenessListeners = new Set<(payload: Uint8Array) => void>();
  readonly syncWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout> | undefined;
  }> = [];

  constructor(
    readonly id: string,
    private readonly hydrator: DocHydrator,
  ) {
    this.doc = new Y.Doc();
    this.text = this.doc.getText(TEXT_ROOT);
  }

  onAwareness(listener: (payload: Uint8Array) => void): () => void {
    this.awarenessListeners.add(listener);
    return () => this.awarenessListeners.delete(listener);
  }

  sendAwareness(payload: Uint8Array): void {
    this.hydrator.sendAwarenessFrame(this.id, payload);
  }

  release(): void {
    if (this.refs > 0) this.refs--;
    if (this.refs === 0) this.hydrator.onLastRelease(this.id);
  }
}

export class DocHydrator {
  readonly #open = new Map<string, DocEntry>();
  readonly #opening = new Map<string, Promise<HydratedDoc>>();
  readonly #awaitingCreate = new Set<string>();
  readonly #seeds = new Map<string, Uint8Array>();
  #queued = 0;
  #pending = 0;

  constructor(
    private readonly transport: SyncTransport,
    private readonly options: DocHydratorOptions = {},
  ) {}

  get openIds(): readonly string[] {
    return [...this.#open.keys()];
  }

  get lruSize(): number {
    return this.options.lruSize ?? DEFAULT_LRU_SIZE;
  }

  get pendingCount(): number {
    return this.#pending;
  }

  async open(id: string): Promise<HydratedDoc> {
    const inFlight = this.#opening.get(id);
    if (inFlight) {
      const handle = await inFlight;
      (handle as DocEntry).refs++;
      this.#touch(id);
      return handle;
    }

    const existing = this.#open.get(id);
    if (existing) {
      this.#touch(id);
      existing.refs++;
      if (!existing.subscribed) this.#subscribe(existing);
      if (!existing.synced && this.transport.state === "open") {
        await this.#awaitSync(existing).catch(() => undefined);
      }
      return existing;
    }

    const opening = this.#openNew(id);
    this.#opening.set(id, opening);
    try {
      return await opening;
    } finally {
      this.#opening.delete(id);
    }
  }

  async #openNew(id: string): Promise<HydratedDoc> {
    const entry = new DocEntry(id, this);
    entry.refs = 1;
    this.#open.set(id, entry);

    const persisted = this.#seeds.get(id) ?? (await this.options.persistence?.load(id));
    if (persisted && persisted.byteLength > 0) {
      try {
        Y.applyUpdate(entry.doc, persisted, RESTORE_ORIGIN);
        entry.hasLocalState = true;
        const stored = await this.options.persistence?.peek?.(id);
        if (stored?.unsynced && stored.journal && stored.journal.length > 0) {
          entry.journal = stored.journal.map((edit) => ({ ...edit, origin: TAB_ID }));
          entry.pending = stored.journal.length;
          this.#recount();
        } else if (stored?.unsynced || this.#awaitingCreate.has(id)) {
          entry.pending = 1;
          this.#recount();
        }
      } catch (cause) {
        await this.options.persistence?.drop(id).catch(() => undefined);
        this.#reportError(id, "internal", `discarded unreadable local replica: ${String(cause)}`);
      }
    }

    entry.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.#onLocalUpdate(entry, update, origin);
    });

    this.#subscribe(entry);
    this.#evict();

    if (this.transport.state !== "open" || this.#awaitingCreate.has(id)) {
      if (entry.hasLocalState) {
        entry.phase = "live";
        return entry;
      }
      this.#reportError(
        id,
        "internal",
        "offline and never hydrated: readable from the projection, not editable until reconnect",
      );
      entry.phase = "error";
      this.#discard(entry);
      throw new Error(`document ${id} cannot be hydrated while offline (never opened)`);
    }
    try {
      await this.#awaitSync(entry);
    } catch (cause) {
      if (entry.phase === "error") {
        this.#discard(entry);
        throw cause;
      }
      entry.phase = "live";
    }
    return entry;
  }

  async seed(id: string, text: string): Promise<Uint8Array> {
    const doc = new Y.Doc();
    doc.getText(TEXT_ROOT).insert(0, text);
    const state = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    this.#awaitingCreate.add(id);
    if (this.options.persistence) await this.options.persistence.save(id, state, { unsynced: true });
    else this.#seeds.set(id, state);
    return state;
  }

  setQueued(count: number): void {
    this.#queued = count;
    this.#recount();
  }

  holdUntilCreated(ids: Iterable<string>): void {
    for (const id of ids) this.#awaitingCreate.add(id);
  }

  created(id: string): void {
    if (!this.#awaitingCreate.delete(id)) return;
    this.#seeds.delete(id);
    const entry = this.#open.get(id);
    if (entry && !entry.subscribed) this.#subscribe(entry);
  }

  async forget(id: string): Promise<void> {
    this.#awaitingCreate.delete(id);
    this.#seeds.delete(id);
    const entry = this.#open.get(id);
    if (entry) {
      entry.pending = 0;
      entry.journal = [];
      this.#discard(entry);
    }
    await this.options.persistence?.drop(id).catch(() => undefined);
  }

  async localText(id: string): Promise<string | undefined> {
    const entry = this.#open.get(id);
    if (entry) return entry.text.toString();
    const state = this.#seeds.get(id) ?? (await this.options.persistence?.load(id));
    if (!state) return undefined;
    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, state, RESTORE_ORIGIN);
      return scratch.getText(TEXT_ROOT).toString();
    } catch {
      return undefined;
    } finally {
      scratch.destroy();
    }
  }

  async sendUnsynced(): Promise<void> {
    const replicas = (await this.options.persistence?.list?.().catch(() => [])) ?? [];
    for (const replica of replicas) {
      if (!replica.unsynced || this.#open.has(replica.id) || this.#awaitingCreate.has(replica.id)) continue;
      if (this.transport.state !== "open") return;
      try {
        const handle = await this.open(replica.id);
        handle.release();
      } catch {
      }
    }
  }

  async absorb(id: string, state: Uint8Array, version: string): Promise<boolean> {
    const persistence = this.options.persistence;
    if (!persistence?.absorb || this.#open.has(id) || this.#opening.has(id)) return false;
    await persistence.absorb(id, state, version);
    return true;
  }

  async unsentIds(): Promise<string[]> {
    const ids = new Set<string>();
    for (const entry of this.#open.values()) if (entry.pending > 0) ids.add(entry.id);
    for (const replica of await this.replicas()) if (replica.unsynced) ids.add(replica.id);
    for (const id of this.#awaitingCreate) ids.add(id);
    return [...ids];
  }

  async replicas(): Promise<Array<{ id: string; unsynced: boolean; version?: string }>> {
    return (await this.options.persistence?.list?.().catch(() => [])) ?? [];
  }

  onBinary(frame: BinaryFrame): void {
    const entry = this.#open.get(frame.docId);
    if (!entry) return;

    switch (frame.type) {
      case FrameType.SyncStep1: {
        entry.acked = true;
        if (entry.refused) {
          this.#onStep1WhileRefused(entry, frame.payload);
          return;
        }
        this.#sendStep2(entry, frame.payload);
        return;
      }
      case FrameType.SyncStep2:
      case FrameType.Update: {
        this.#applyRemote(entry, frame.payload);
        if (frame.type === FrameType.SyncStep2) this.#markSynced(entry);
        return;
      }
      case FrameType.Awareness: {
        for (const listener of entry.awarenessListeners) listener(frame.payload);
        return;
      }
      default:
        return;
    }
  }

  onResync(resync: DocResync): void {
    if (resync.id !== undefined) {
      this.#sendStep1(resync.id);
      return;
    }
    for (const id of this.#open.keys()) this.#sendStep1(id);
  }

  onSubscribed(message: DocSubscribed): void {
    const entry = this.#open.get(message.id);
    if (!entry || !entry.subscribed) return;
    entry.acked = true;
    this.#flush(entry);
  }

  onDocError(error: DocError): void {
    const entry = this.#open.get(error.id);
    if (entry) {
      switch (error.code) {
        case "too_large":
          if (error.hint === "rest") void this.#hydrateOverRest(entry);
          else this.#markRefused(entry);
          break;
        case "gone":
        case "not_found":
        case "invalid_id":
          entry.phase = "error";
          entry.subscribed = false;
          this.#rejectWaiters(entry, new Error(`document ${error.id}: ${error.code}`));
          break;
        case "too_many_subscriptions":
        case "contended":
        case "internal":
        case "malformed_update":
          break;
      }
    }
    this.options.onError?.(error.id, error);
  }

  resubscribeAll(): void {
    for (const entry of this.#open.values()) {
      entry.synced = false;
      entry.acked = false;
      entry.subscribed = false;
      this.#subscribe(entry);
    }
  }

  onDisconnected(): void {
    for (const entry of this.#open.values()) {
      entry.subscribed = false;
      entry.synced = false;
      entry.acked = false;
    }
  }

  async dropReplicas(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const entry = this.#open.get(id);
      if (entry) {
        this.options.onReplicaDiscarded?.({
          id,
          hadUnsyncedEdits: entry.pending > 0,
          text: entry.text.toString(),
        });
        this.#discard(entry);
      } else {
        await this.#offerPersistedReplica(id);
      }
      await this.options.persistence?.drop(id).catch(() => undefined);
    }
  }

  async #offerPersistedReplica(id: string): Promise<void> {
    const persistence = this.options.persistence;
    const onDiscarded = this.options.onReplicaDiscarded;
    if (!persistence || !onDiscarded) return;

    let stored: StoredReplica | undefined;
    try {
      stored = persistence.peek
        ? await persistence.peek(id)
        : await persistence.load(id).then((state) => (state ? { state } : undefined));
    } catch {
      return;
    }
    if (!stored || stored.state.byteLength === 0) return;

    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, stored.state, RESTORE_ORIGIN);
      onDiscarded({
        id,
        hadUnsyncedEdits: stored.unsynced ?? true,
        text: scratch.getText(TEXT_ROOT).toString(),
      });
    } catch {
    } finally {
      scratch.destroy();
    }
  }

  releaseAll(): void {
    for (const entry of [...this.#open.values()]) {
      entry.refs = 0;
      this.#persistNow(entry);
      this.#discard(entry);
    }
    this.#open.clear();
    this.#recount();
  }

  sendAwarenessFrame(id: string, payload: Uint8Array): void {
    if (this.transport.state !== "open") return;
    try {
      this.transport.sendBinary({ type: FrameType.Awareness, docId: id, payload });
    } catch {
    }
  }

  onLastRelease(id: string): void {
    const entry = this.#open.get(id);
    if (!entry || entry.refs > 0) return;
    this.#persistNow(entry);
    if (entry.subscribed && this.transport.state === "open") {
      try {
        this.transport.sendControl({ t: "doc.unsubscribe", id });
      } catch {
      }
    }
    entry.subscribed = false;
    entry.acked = false;
    entry.synced = false;
    this.#evict();
  }

  #subscribe(entry: DocEntry): void {
    if (this.transport.state !== "open" || this.#awaitingCreate.has(entry.id)) return;
    const sv = Y.encodeStateVector(entry.doc);
    const hasLocalState = entry.hasLocalState;
    try {
      this.transport.sendControl({
        t: "doc.subscribe",
        id: entry.id,
        ...(hasLocalState ? { sv: toBase64(sv) } : {}),
      });
      this.transport.sendBinary({ type: FrameType.SyncStep1, docId: entry.id, payload: sv });
      entry.subscribed = true;
    } catch {
      entry.subscribed = false;
    }
  }

  #sendStep1(id: string): void {
    const entry = this.#open.get(id);
    if (!entry || this.transport.state !== "open") return;
    try {
      this.transport.sendBinary({
        type: FrameType.SyncStep1,
        docId: id,
        payload: Y.encodeStateVector(entry.doc),
      });
    } catch {
    }
  }

  #sendStep2(entry: DocEntry, theirStateVector: Uint8Array): void {
    if (this.transport.state !== "open") return;
    this.#flush(entry);
    let update: Uint8Array;
    try {
      update = Y.encodeStateAsUpdate(entry.doc, theirStateVector);
    } catch (cause) {
      this.#reportError(entry.id, "malformed_update", `unusable state vector: ${String(cause)}`);
      return;
    }
    try {
      this.transport.sendBinary({
        type: FrameType.SyncStep2,
        docId: entry.id,
        payload: update,
      });
      this.#clearOutbox(entry);
    } catch (cause) {
      this.#reportError(entry.id, "too_large", `could not send state diff: ${String(cause)}`);
    }
  }

  #applyRemote(entry: DocEntry, payload: Uint8Array): void {
    try {
      Y.applyUpdate(entry.doc, payload, REMOTE_ORIGIN);
    } catch (cause) {
      this.#reportError(entry.id, "malformed_update", `could not apply update: ${String(cause)}`);
    }
  }

  #markRefused(entry: DocEntry): void {
    entry.refused = true;
    entry.verifyOnly = false;
    if (entry.pending === 0) {
      entry.pending = 1;
      this.#recount();
    }
    entry.dirty = true;
    this.#schedulePersist(entry);
  }

  #scheduleRetry(entry: DocEntry): void {
    entry.retryPending = true;
    if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (entry.refused && this.transport.state === "open") this.#subscribe(entry);
    }, REFUSED_RETRY_MS);
  }

  #onStep1WhileRefused(entry: DocEntry, serverVector: Uint8Array): void {
    if (coversVector(serverVector, Y.encodeStateVector(entry.doc))) {
      entry.refused = false;
      entry.retryPending = false;
      entry.verifyOnly = false;
      this.#clearOutbox(entry);
      this.options.onRefusalCleared?.(entry.id);
      return;
    }
    if (entry.verifyOnly) {
      entry.verifyOnly = false;
      return;
    }
    if (!entry.retryPending) return;
    entry.retryPending = false;
    this.#sendStep2(entry, serverVector);
    entry.verifyOnly = true;
    setTimeout(() => {
      if (entry.refused && entry.verifyOnly && this.transport.state === "open") this.#subscribe(entry);
    }, REFUSED_VERIFY_MS);
  }

  #onLocalUpdate(entry: DocEntry, update: Uint8Array, origin: unknown): void {
    entry.dirty = true;
    entry.hasLocalState = true;
    if (origin === REMOTE_ORIGIN || origin === RESTORE_ORIGIN) {
      this.#schedulePersist(entry);
      return;
    }

    if (entry.refused) {
      this.#queue(entry, update);
      this.#schedulePersist(entry);
      this.#scheduleRetry(entry);
      return;
    }
    if (this.transport.state === "open" && entry.subscribed) {
      try {
        this.transport.sendBinary({ type: FrameType.Update, docId: entry.id, payload: update });
        this.#schedulePersist(entry);
        return;
      } catch {
      }
    }
    this.#queue(entry, update);
    this.#schedulePersist(entry);
    this.options.onLocalEdit?.(entry.id, entry.text.toString());
  }

  #queue(entry: DocEntry, update: Uint8Array): void {
    const now = Date.now();
    const last = entry.journal.at(-1);
    if (last && now - last.lastAt <= JOURNAL_MERGE_MS) {
      entry.journal[entry.journal.length - 1] = {
        origin: TAB_ID,
        at: last.at,
        lastAt: now,
        update: Y.mergeUpdates([last.update, update]),
      };
    } else {
      entry.journal.push({ origin: TAB_ID, at: now, lastAt: now, update });
    }
    entry.pending++;
    this.#recount();
  }

  #flush(entry: DocEntry): void {
    if (entry.journal.length === 0 || this.transport.state !== "open") return;
    try {
      for (const edit of entry.journal) {
        this.transport.sendBinary({ type: FrameType.History, docId: entry.id, payload: encodeHistory(edit.at, edit.update) });
      }
      this.#clearOutbox(entry);
      this.options.onOfflineEditsSent?.(entry.id);
    } catch (cause) {
      this.#reportError(entry.id, "too_large", `could not flush offline edits: ${String(cause)}`);
    }
  }

  #clearOutbox(entry: DocEntry): void {
    if (entry.pending === 0 && entry.journal.length === 0) return;
    entry.journal = [];
    entry.pending = 0;
    entry.dirty = true;
    this.#schedulePersist(entry);
    this.#recount();
  }

  #recount(): void {
    let pending = this.#queued;
    for (const entry of this.#open.values()) pending += entry.pending;
    if (pending === this.#pending) return;
    this.#pending = pending;
    this.options.onPending?.(pending);
  }

  #markSynced(entry: DocEntry): void {
    entry.synced = true;
    if (entry.phase === "hydrating") entry.phase = "live";
    this.#flush(entry);
    const waiters = entry.syncWaiters.splice(0, entry.syncWaiters.length);
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  #rejectWaiters(entry: DocEntry, error: Error): void {
    const waiters = entry.syncWaiters.splice(0, entry.syncWaiters.length);
    for (const waiter of waiters) {
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  #awaitSync(entry: DocEntry): Promise<void> {
    if (entry.synced) return Promise.resolve();
    if (entry.phase === "error") {
      return Promise.reject(new Error(`document ${entry.id} could not be hydrated`));
    }
    return new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.syncTimeoutMs ?? SYNC_TIMEOUT_MS;
      const waiter = {
        resolve,
        reject,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const index = entry.syncWaiters.indexOf(waiter);
          if (index >= 0) entry.syncWaiters.splice(index, 1);
          reject(new Error(`document ${entry.id} did not sync within ${timeoutMs} ms`));
        }, timeoutMs);
        (waiter.timer as unknown as { unref?: () => void }).unref?.();
      }
      entry.syncWaiters.push(waiter);
    });
  }

  #schedulePersist(entry: DocEntry): void {
    const persistence = this.options.persistence;
    if (!persistence) return;
    const debounce = this.options.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;
    if (debounce <= 0) {
      this.#persistNow(entry);
      return;
    }
    if (entry.persistTimer !== undefined) return;
    entry.persistTimer = setTimeout(() => {
      entry.persistTimer = undefined;
      this.#persistNow(entry);
    }, debounce);
    (entry.persistTimer as unknown as { unref?: () => void }).unref?.();
  }

  #persistNow(entry: DocEntry): void {
    const persistence = this.options.persistence;
    if (!persistence || !entry.dirty) return;
    if (entry.persistTimer !== undefined) {
      clearTimeout(entry.persistTimer);
      entry.persistTimer = undefined;
    }
    entry.dirty = false;
    const state = Y.encodeStateAsUpdate(entry.doc);
    void persistence
      .save(entry.id, state, { unsynced: entry.pending > 0, journal: entry.journal })
      .then(() =>
        persistence.prune(
          Math.max(this.options.persistedReplicas ?? DEFAULT_PERSISTED_REPLICAS, this.lruSize),
        ),
      )
      .catch(() => {
        entry.dirty = true;
      });
  }

  #evict(): void {
    if (this.#open.size <= this.lruSize) return;
    for (const entry of [...this.#open.values()]) {
      if (this.#open.size <= this.lruSize) return;
      if (entry.refs > 0 || entry.pending > 0) continue;
      this.#persistNow(entry);
      this.#discard(entry);
    }
  }

  #discard(entry: DocEntry): void {
    if (entry.persistTimer !== undefined) {
      clearTimeout(entry.persistTimer);
      entry.persistTimer = undefined;
    }
    if (entry.subscribed && this.transport.state === "open") {
      try {
        this.transport.sendControl({ t: "doc.unsubscribe", id: entry.id });
      } catch {
      }
    }
    entry.subscribed = false;
    entry.phase = "released";
    this.#rejectWaiters(entry, new Error(`document ${entry.id} was released`));
    this.#open.delete(entry.id);
    entry.doc.destroy();
    this.#recount();
  }

  #touch(id: string): void {
    const entry = this.#open.get(id);
    if (!entry) return;
    this.#open.delete(id);
    this.#open.set(id, entry);
  }

  async #hydrateOverRest(entry: DocEntry): Promise<void> {
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
    if (!fetchImpl) return;
    const base =
      this.options.restBaseUrl ??
      (typeof location === "undefined" ? "http://127.0.0.1:8080" : location.href);
    const url = new URL(`/api/documents/${encodeURIComponent(entry.id)}`, base);
    url.searchParams.set("format", "crdt");
    const headers: Record<string, string> = { accept: "application/octet-stream" };
    if (this.options.bearerToken) headers.authorization = `Bearer ${this.options.bearerToken}`;
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers,
        credentials: "include",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const state = new Uint8Array(await response.arrayBuffer());
      this.#applyRemote(entry, state);
      entry.subscribed = false;
      this.#subscribe(entry);
    } catch (cause) {
      this.#reportError(entry.id, "internal", `REST hydration failed: ${String(cause)}`);
    }
  }

  #reportError(id: string, code: DocError["code"], message: string): void {
    this.options.onError?.(id, {
      t: "doc.error",
      id,
      code,
      message,
      retryable: code !== "gone" && code !== "invalid_id",
    });
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
