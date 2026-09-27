/**
 * Lazy document hydration (SPEC §4.1: "Full Y.Docs hydrate lazily … LRU-cached
 * (~20 in memory), persisted locally for recently/currently edited docs").
 *
 * One `HydratedDoc` per open document, each one subscribed over the socket with
 * the y-protocols exchange of PROTOCOL.md §3. Awareness passes through
 * untouched — the kernel never parses it (SPEC §3.2).
 *
 * Three things here decide whether offline editing actually works:
 *
 * 1. **The persisted replica is the durable queue.** A local edit is written to
 *    the `docs` store as full encoded state, together with the **edit journal**:
 *    the offline edits as `{ at, update }` entries, so the server's history can say
 *    when each was made (`docs/HISTORY.md`). On reconnect the journal goes first,
 *    as `HISTORY` frames; the ordinary state-vector handshake after it is the
 *    safety net, and the only path when the journal is gone (an older replica, or
 *    site data cleared) — then the edits still arrive, stamped when they did.
 * 2. **Every recovery move is a re-derivation.** `doc.resync`, a reconnect, and a
 *    `too_large` fallback all end in "send a state vector, apply the diff" —
 *    never a replay of remembered frames.
 * 3. **Local edits are never dropped to make room.** The LRU evicts only
 *    documents with no live handle *and* an empty journal.
 *
 * **FROZEN INTERFACE.**
 */

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

/** In-memory replica budget (SPEC §4.1). */
export const DEFAULT_LRU_SIZE = 20;

/** The root `Y.Text` key — pinned by SPEC §3.2; must match the server's `TEXT_ROOT`. */
export const TEXT_ROOT = "content";

/** Offline edits closer together than this are one journal entry, timed at the first. */
export const JOURNAL_MERGE_MS = 2_000;

/** One offline edit, or a run of them, and when it began. */
export interface JournalEntry {
  /** Epoch ms of the first edit in the entry. */
  readonly at: number;
  /** Epoch ms of the last, for merging the next one in. */
  readonly lastAt: number;
  readonly update: Uint8Array;
}

/** Local replica writes are coalesced over this window. */
export const PERSIST_DEBOUNCE_MS = 500;

/**
 * How many documents keep a persisted replica — the "editable offline" set
 * (SPEC §4.1). Deliberately larger than the in-memory LRU: evicting a Y.Doc from
 * memory costs a reload, evicting it from IndexedDB costs the ability to edit
 * that document offline at all.
 */
export const DEFAULT_PERSISTED_REPLICAS = 50;

/**
 * How long `open()` waits for the first sync round trip before resolving with
 * whatever the local replica holds. A slow server must not make a document
 * unopenable — the socket keeps syncing in the background either way.
 */
export const SYNC_TIMEOUT_MS = 15_000;

export type DocPhase = "hydrating" | "live" | "error" | "released";

export interface HydratedDoc {
  readonly id: string;
  readonly doc: Y.Doc;
  /** The one root `Y.Text` holding the whole document text. */
  readonly text: Y.Text;
  readonly phase: DocPhase;
  /** Awareness frames for this document, relayed opaquely both ways. */
  onAwareness(listener: (payload: Uint8Array) => void): () => void;
  sendAwareness(payload: Uint8Array): void;
  /** Release the local handle; the last release unsubscribes from the server. */
  release(): void;
}

export interface DocHydratorOptions {
  readonly lruSize?: number;
  /**
   * Persisted replica storage for recently edited documents. `undefined` ⇒
   * memory-only (the harness and the M2 demo).
   */
  readonly persistence?: DocPersistence;
  /** Documents that keep a local replica; default {@link DEFAULT_PERSISTED_REPLICAS}. */
  readonly persistedReplicas?: number;
  readonly onError?: (id: string, error: DocError) => void;
  /** Local replica writes are coalesced over this window; tests set it to 0. */
  readonly persistDebounceMs?: number;
  /** `open()`'s first-round-trip deadline. */
  readonly syncTimeoutMs?: number;
  /** Called whenever the journal depth changes — the `pending` half of sync status. */
  readonly onPending?: (pending: number) => void;
  /**
   * A local replica was discarded because the document was purged server-side
   * (PROTOCOL.md §2.1). `hadUnsyncedEdits` ⇒ offer "restore your version as a new
   * document" with `text` *before* it is gone (SPEC §4.1); the id itself can
   * never be reused.
   */
  readonly onReplicaDiscarded?: (info: {
    readonly id: string;
    readonly hadUnsyncedEdits: boolean;
    readonly text: string;
  }) => void;
  /** REST origin for the `too_large` hydration fallback; default: page origin. */
  readonly restBaseUrl?: string;
  /** Bearer token for that fallback (shells and tests); browsers use the cookie. */
  readonly bearerToken?: string;
  /** Injectable for tests and the Node harness. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * What is known about a persisted replica besides its bytes.
 *
 * `unsynced` is the load-bearing field: it is the only way anything outside this
 * module can tell a replica that is merely *cached* from one that holds edits the
 * server has never seen. Two decisions depend on it and both of them destroy user
 * work when it is missing — LRU eviction (which must not drop such a replica) and
 * the purge path (which must offer it back before deleting it, SPEC §4.1).
 */
export interface DocReplicaMeta {
  /** `true` ⇒ the replica holds local edits the socket has not carried. */
  readonly unsynced: boolean;
  /** Those edits, with when they were made. Empty or absent when in sync. */
  readonly journal?: readonly JournalEntry[];
}

/** A persisted replica as {@link DocPersistence.peek} reports it. */
export interface StoredReplica extends Partial<DocReplicaMeta> {
  readonly state: Uint8Array;
}

/** Local persistence of hydrated replicas — the `docs` IndexedDB store. */
export interface DocPersistence {
  load(id: string): Promise<Uint8Array | undefined>;
  save(id: string, state: Uint8Array, meta?: DocReplicaMeta): Promise<void>;
  drop(id: string): Promise<void>;
  /**
   * Evict the least-recently-touched replicas beyond `keep` — **never** one flagged
   * `unsynced`, whatever its recency.
   */
  prune(keep: number): Promise<string[]>;
  /**
   * Read a replica without counting as a use (so it does not disturb the LRU),
   * together with its flags. Optional: an implementation without it cannot
   * distinguish an unsynced replica from a cached one, and the hydrator then errs
   * towards offering recovery.
   */
  peek?(id: string): Promise<StoredReplica | undefined>;
}

/** Marks updates that came off the wire, so they are not echoed back to it. */
const REMOTE_ORIGIN = Symbol("life-manager:remote");
/**
 * Marks the replay of a persisted replica. Not queued for sending: the state
 * vector handshake is what tells the server about anything in it that it lacks,
 * and that works whether the replica is one edit old or a hundred.
 */
const RESTORE_ORIGIN = Symbol("life-manager:restore");

/** Everything the hydrator knows about one open document. */
class DocEntry implements HydratedDoc {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  phase: DocPhase = "hydrating";
  /** Live handles. `0` ⇒ evictable, and the server subscription is dropped. */
  refs = 0;
  /** `doc.subscribe` has been sent on the current connection. */
  subscribed = false;
  /** The first sync round trip of the current connection has completed. */
  synced = false;
  /** `doc.subscribed` seen on the current connection. */
  acked = false;
  /** Local edits the socket has not carried yet (offline edits), oldest first. */
  journal: JournalEntry[] = [];
  /** Number of local transactions in `journal` — the honest "pending" count. */
  pending = 0;
  /** Local state not yet written to the `docs` store. */
  dirty = false;
  /**
   * `true` once this replica holds anything at all — a restored blob or a local
   * edit. It is the "already have a replica" test of PROTOCOL.md §3.3: an empty
   * document sends no `sv` and lets the server answer with the whole state.
   */
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
    // Ephemeral by definition (SPEC §3.2): if the socket cannot carry it now,
    // it is not worth remembering.
    this.hydrator.sendAwarenessFrame(this.id, payload);
  }

  release(): void {
    if (this.refs > 0) this.refs--;
    if (this.refs === 0) this.hydrator.onLastRelease(this.id);
  }
}

export class DocHydrator {
  readonly #open = new Map<string, DocEntry>();
  /** In-flight first opens, so concurrent callers share one replica. */
  readonly #opening = new Map<string, Promise<HydratedDoc>>();
  #pending = 0;

  constructor(
    private readonly transport: SyncTransport,
    private readonly options: DocHydratorOptions = {},
  ) {}

  /** Documents currently hydrated (LRU order, most recent first). */
  get openIds(): readonly string[] {
    return [...this.#open.keys()];
  }

  get lruSize(): number {
    return this.options.lruSize ?? DEFAULT_LRU_SIZE;
  }

  /**
   * Local edits waiting for the socket — the `pending` count of the sync status
   * observable (SPEC §6.4). Zero does not mean "the server has materialized it";
   * it means "nothing is waiting on this client".
   */
  get pendingCount(): number {
    return this.#pending;
  }

  /**
   * Open a document for editing: load any local replica, subscribe over the
   * socket, and resolve once the first sync round trip completes.
   *
   * Offline, it resolves from the local replica alone — that is what makes
   * "documents you have opened are editable offline" true (SPEC §4.1).
   */
  async open(id: string): Promise<HydratedDoc> {
    // Two UI surfaces opening the same document in the same tick is ordinary, and
    // must not produce two replicas or two handshakes: the in-flight open is
    // shared, and each caller gets its own reference count on the result.
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

  /** First open of a document: replica, subscription, first round trip. */
  async #openNew(id: string): Promise<HydratedDoc> {
    const entry = new DocEntry(id, this);
    entry.refs = 1;
    this.#open.set(id, entry);

    const persisted = await this.options.persistence?.load(id);
    if (persisted && persisted.byteLength > 0) {
      try {
        Y.applyUpdate(entry.doc, persisted, RESTORE_ORIGIN);
        entry.hasLocalState = true;
        // Offline edits from before a reload: their journal comes back with them.
        const stored = await this.options.persistence?.peek?.(id);
        if (stored?.unsynced && stored.journal && stored.journal.length > 0) {
          entry.journal = [...stored.journal];
          entry.pending = stored.journal.length;
          this.#recount();
        }
      } catch (cause) {
        // A corrupt local blob must not make the document unopenable: drop it and
        // hydrate from the server instead.
        await this.options.persistence?.drop(id).catch(() => undefined);
        this.#reportError(id, "internal", `discarded unreadable local replica: ${String(cause)}`);
      }
    }

    entry.doc.on("update", (update: Uint8Array, origin: unknown) => {
      this.#onLocalUpdate(entry, update, origin);
    });

    this.#subscribe(entry);
    this.#evict();

    if (this.transport.state !== "open") {
      if (entry.hasLocalState) {
        // Offline with a replica on disk: it *is* the document (SPEC §4.1 —
        // "editable offline = documents you've opened"). Sync happens on reconnect.
        entry.phase = "live";
        return entry;
      }
      // Offline and never opened before: there is **nothing here to edit**, and
      // SPEC §4.1 says so in as many words — "an unopened document is read-only
      // offline until reconnect".
      //
      // The empty `Y.Doc` above is not this document; it is a blank one that happens
      // to share its id. Returning it as `live` hands an editor an empty `Y.Text`
      // while the projection row next to it is full of text, so the reader sees a
      // populated read view, switches to edit, and is invited to type into a replica
      // that is not the document. (The CRDT merge on reconnect is not *lossy* — Yjs
      // merges the insert in — but it lands in a document the user never saw, which
      // is worse than being told no.)
      //
      // Failing here is what surfaces the read-only path callers already implement:
      // `document-surface` keeps reading from `row.content` and says "editing is
      // unavailable", and `editor` shows that text read-only instead of an empty box.
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
      // Timeout only: keep the document usable, keep syncing in the background.
      entry.phase = "live";
    }
    return entry;
  }

  /** Route an inbound binary frame to its document. */
  onBinary(frame: BinaryFrame): void {
    const entry = this.#open.get(frame.docId);
    // A frame for a document we released (or never opened) is not an error: the
    // server may have had it queued when the unsubscribe crossed it.
    if (!entry) return;

    switch (frame.type) {
      case FrameType.SyncStep1: {
        // "Here is what I have" — answer with everything they lack, which is also
        // how offline edits reach the server after a reconnect. Note what this
        // does *not* do: mark the document synced. Their step 1 says nothing
        // about our content arriving; only their step 2 does.
        this.#sendStep2(entry, frame.payload);
        entry.acked = true;
        return;
      }
      case FrameType.SyncStep2:
      case FrameType.Update: {
        this.#applyRemote(entry, frame.payload);
        if (frame.type === FrameType.SyncStep2) this.#markSynced(entry);
        return;
      }
      case FrameType.Awareness: {
        // Relayed opaquely, never parsed, never persisted (SPEC §3.2).
        for (const listener of entry.awarenessListeners) listener(frame.payload);
        return;
      }
      default:
        // `AWARENESS_QUERY` is client→server, and ≥ `RESERVED_FRAME_TYPE_FLOOR`
        // is reserved for M4 plugin channels: an unknown inbound type is ignored,
        // never fatal (PROTOCOL.md §3.1, §9).
        return;
    }
  }

  /** `doc.resync`: re-send `SYNC_STEP1` for the named document, or for all of them. */
  onResync(resync: DocResync): void {
    if (resync.id !== undefined) {
      this.#sendStep1(resync.id);
      return;
    }
    for (const id of this.#open.keys()) this.#sendStep1(id);
  }

  /** `doc.subscribed`: the server has us in the room (PROTOCOL.md §3.3). */
  onSubscribed(message: DocSubscribed): void {
    const entry = this.#open.get(message.id);
    if (!entry) return;
    entry.acked = true;
    entry.subscribed = true;
    // Anything queued while offline goes now; the handshake that follows is the
    // safety net, not the mechanism.
    this.#flush(entry);
  }

  onDocError(error: DocError): void {
    const entry = this.#open.get(error.id);
    if (entry) {
      switch (error.code) {
        case "too_large":
          // Two different failures share this code, and only one of them has a
          // fallback. `hint: "rest"` means "the *diff* does not fit in a frame":
          // hydrate over REST, which has no frame limit, then re-subscribe with the
          // resulting state vector (PROTOCOL.md §3.5). No hint means the server
          // *refused a write* whose result would exceed `MAX_DOCUMENT_BYTES`
          // (SPEC §3.5) — there is nothing to hydrate, the server state is
          // unchanged, and downloading the whole document would prove it. That one
          // is surfaced to the caller through `onError` and nothing else.
          if (error.hint === "rest") void this.#hydrateOverRest(entry);
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
          // Retryable or frame-local: the document stays open and the next
          // handshake or resync repairs it.
          break;
      }
    }
    this.options.onError?.(error.id, error);
  }

  /**
   * Re-subscribe every open document after a reconnect (each one restarts the
   * PROTOCOL.md §3.3 handshake from its current state vector).
   */
  resubscribeAll(): void {
    for (const entry of this.#open.values()) {
      entry.synced = false;
      entry.acked = false;
      entry.subscribed = false;
      this.#subscribe(entry);
    }
  }

  /** The socket is gone: nothing is subscribed, and new edits queue up. */
  onDisconnected(): void {
    for (const entry of this.#open.values()) {
      entry.subscribed = false;
      entry.synced = false;
      entry.acked = false;
    }
  }

  /**
   * A purge arrived through the feed (PROTOCOL.md §2.1): drop the local replica,
   * offering recovery first if it held edits the server never saw.
   */
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
        // No in-memory replica does **not** mean no local edits. Edits made offline
        // are merged into the persisted `docs` blob, and a reload (or just closing
        // the tab) leaves them on disk with nothing open. Deleting that blob because
        // a purge row arrived is the one way this client silently destroys work the
        // user can still see in their doc list, so the persisted copy gets the same
        // recovery offer the open one does (SPEC §4.1).
        await this.#offerPersistedReplica(id);
      }
      await this.options.persistence?.drop(id).catch(() => undefined);
    }
  }

  /**
   * Offer a persisted-but-not-open replica back before it is deleted.
   *
   * When the store cannot say whether the replica held unsynced edits (no `peek`,
   * or a record written before the flag existed), it is reported as unsynced: a
   * recovery prompt for a replica that turns out to have been in sync is a
   * redundant dialog, and the other error is unrecoverable data loss.
   */
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

    // A throwaway doc, purely to read the text out of the blob.
    const scratch = new Y.Doc();
    try {
      Y.applyUpdate(scratch, stored.state, RESTORE_ORIGIN);
      onDiscarded({
        id,
        hadUnsyncedEdits: stored.unsynced ?? true,
        text: scratch.getText(TEXT_ROOT).toString(),
      });
    } catch {
      // An unreadable blob has nothing to offer back; it is about to be deleted
      // either way.
    } finally {
      scratch.destroy();
    }
  }

  /** Release everything (logout, page unload). Local replicas are left on disk. */
  releaseAll(): void {
    for (const entry of [...this.#open.values()]) {
      entry.refs = 0;
      this.#persistNow(entry);
      this.#discard(entry);
    }
    this.#open.clear();
    this.#recount();
  }

  /** Awareness out. Called by the handle; dropped when the socket cannot take it. */
  sendAwarenessFrame(id: string, payload: Uint8Array): void {
    if (this.transport.state !== "open") return;
    try {
      this.transport.sendBinary({ type: FrameType.Awareness, docId: id, payload });
    } catch {
      /* ephemeral: presence is never worth an error path */
    }
  }

  /** The last handle for `id` went away: stop the server fan-out, keep the replica. */
  onLastRelease(id: string): void {
    const entry = this.#open.get(id);
    if (!entry || entry.refs > 0) return;
    this.#persistNow(entry);
    if (entry.subscribed && this.transport.state === "open") {
      try {
        this.transport.sendControl({ t: "doc.unsubscribe", id });
      } catch {
        /* the socket is going away anyway */
      }
    }
    entry.subscribed = false;
    // The Y.Doc stays in the LRU: reopening it is then free, and it is still the
    // offline-editable copy. `#evict` is what eventually reclaims it.
    this.#evict();
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  #subscribe(entry: DocEntry): void {
    if (this.transport.state !== "open") return;
    const sv = Y.encodeStateVector(entry.doc);
    const hasLocalState = entry.hasLocalState;
    try {
      this.transport.sendControl({
        t: "doc.subscribe",
        id: entry.id,
        ...(hasLocalState ? { sv: toBase64(sv) } : {}),
      });
      // Always volunteer our state vector too: the server answers a STEP1 with a
      // STEP2, so this is what guarantees the round trip completes even when the
      // server had nothing to volunteer on its own (PROTOCOL.md §3.3).
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
      /* the reconnect loop repairs it */
    }
  }

  #sendStep2(entry: DocEntry, theirStateVector: Uint8Array): void {
    if (this.transport.state !== "open") return;
    // The journal first: it carries the times this diff would lose.
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
      // Whatever was queued is now covered by the diff we just sent.
      this.#clearOutbox(entry);
    } catch (cause) {
      // Oversize is the documented corner (PROTOCOL.md §3.5): the server offers
      // REST for its half; ours stays queued for the next handshake.
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

  #onLocalUpdate(entry: DocEntry, update: Uint8Array, origin: unknown): void {
    entry.dirty = true;
    entry.hasLocalState = true;
    // Persist *after* the journal has been updated, never before: the saved record
    // carries an `unsynced` flag taken from `entry.pending`, and with a zero
    // debounce a save ordered first would stamp "in sync" onto the very blob that
    // is about to become the only copy of an offline edit.
    if (origin === REMOTE_ORIGIN || origin === RESTORE_ORIGIN) {
      this.#schedulePersist(entry);
      return;
    }

    if (this.transport.state === "open" && entry.subscribed) {
      try {
        this.transport.sendBinary({ type: FrameType.Update, docId: entry.id, payload: update });
        this.#schedulePersist(entry);
        return;
      } catch {
        /* fall through to the journal */
      }
    }
    this.#queue(entry, update);
    this.#schedulePersist(entry);
  }

  #queue(entry: DocEntry, update: Uint8Array): void {
    const now = Date.now();
    const last = entry.journal.at(-1);
    if (last && now - last.lastAt <= JOURNAL_MERGE_MS) {
      entry.journal[entry.journal.length - 1] = {
        at: last.at,
        lastAt: now,
        update: Y.mergeUpdates([last.update, update]),
      };
    } else {
      entry.journal.push({ at: now, lastAt: now, update });
    }
    entry.pending++;
    this.#recount();
  }

  /**
   * Send the journal as `HISTORY` frames, oldest first, so the server can record when
   * each edit was made. Runs before any `SYNC_STEP2` of ours: sent after, the diff
   * would already carry these edits and the times would be lost.
   */
  #flush(entry: DocEntry): void {
    if (entry.journal.length === 0 || this.transport.state !== "open") return;
    try {
      for (const edit of entry.journal) {
        this.transport.sendBinary({ type: FrameType.History, docId: entry.id, payload: encodeHistory(edit.at, edit.update) });
      }
      this.#clearOutbox(entry);
    } catch (cause) {
      // Too large for one frame: the state-vector handshake is the escape hatch (the
      // edits then arrive stamped when they did), and the journal stays until it runs.
      this.#reportError(entry.id, "too_large", `could not flush offline edits: ${String(cause)}`);
    }
  }

  #clearOutbox(entry: DocEntry): void {
    if (entry.pending === 0 && entry.journal.length === 0) return;
    entry.journal = [];
    entry.pending = 0;
    // The bytes on disk have not changed, but the *flag* on them has: the replica is
    // no longer holding anything the server lacks, so it may be pruned again. Left
    // stale, a document edited once offline would be pinned in IndexedDB forever.
    entry.dirty = true;
    this.#schedulePersist(entry);
    this.#recount();
  }

  #recount(): void {
    let pending = 0;
    for (const entry of this.#open.values()) pending += entry.pending;
    if (pending === this.#pending) return;
    this.#pending = pending;
    this.options.onPending?.(pending);
  }

  #markSynced(entry: DocEntry): void {
    entry.synced = true;
    if (entry.phase === "hydrating") entry.phase = "live";
    // Anything still queued is already covered by the diff exchange, but a local
    // edit made *during* the handshake is not: flush it now.
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
        // Node: a pending timer must not hold the process open for the harness.
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
      // The flag travels with the bytes, so the two can never disagree: `prune`
      // refuses to evict this replica while it holds unsynced edits, and a purge
      // offers it back instead of deleting it (SPEC §4.1).
      .save(entry.id, state, { unsynced: entry.pending > 0, journal: entry.journal })
      .then(() =>
        persistence.prune(
          Math.max(this.options.persistedReplicas ?? DEFAULT_PERSISTED_REPLICAS, this.lruSize),
        ),
      )
      .catch(() => {
        // Storage refused (quota, private mode). The document stays editable in
        // memory; the kernel surfaces quota warnings separately (SPEC §6.4).
        entry.dirty = true;
      });
  }

  /**
   * LRU eviction, oldest first. Two kinds of document are never evicted: one
   * with a live handle, and one with queued local edits — dropping the latter
   * would strand those edits until the user happened to reopen the document.
   */
  #evict(): void {
    if (this.#open.size <= this.lruSize) return;
    for (const entry of [...this.#open.values()]) {
      if (this.#open.size <= this.lruSize) return;
      if (entry.refs > 0 || entry.pending > 0) continue;
      this.#persistNow(entry);
      this.#discard(entry);
    }
  }

  /** Forget a document in memory. The persisted replica (if any) is left alone. */
  #discard(entry: DocEntry): void {
    if (entry.persistTimer !== undefined) {
      clearTimeout(entry.persistTimer);
      entry.persistTimer = undefined;
    }
    if (entry.subscribed && this.transport.state === "open") {
      try {
        this.transport.sendControl({ t: "doc.unsubscribe", id: entry.id });
      } catch {
        /* ignore */
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

  /**
   * `doc.error { code: "too_large", hint: "rest" }`: pull the whole CRDT state
   * over `GET /api/documents/:id?format=crdt` (no frame limit), then restart the
   * handshake with the state vector that results (PROTOCOL.md §3.5).
   */
  // INTEGRATION (server, http-routes): this path depends on
  // `GET /api/documents/:id?format=crdt` answering with the raw encoded state as
  // `application/octet-stream` (update encoding v1) — which is what M1 does today.
  // If that ever becomes a JSON envelope, this is the client half that breaks.
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
      // Re-subscribe with the state vector we now have; the server's next answer
      // is a small diff instead of the whole document.
      entry.subscribed = false;
      this.#subscribe(entry);
    } catch (cause) {
      this.#reportError(entry.id, "internal", `REST hydration failed: ${String(cause)}`);
    }
  }

  /** Synthesize a client-side `doc.error` so every failure path has one shape. */
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

/** Base64 (standard, padded) — what `doc.subscribe.sv` carries. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}
