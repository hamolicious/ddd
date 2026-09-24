/**
 * One simulated client: a bearer session, the kernel's real {@link SyncTransport}
 * over a real WebSocket, real `Y.Doc` replicas, and an in-memory stand-in for the
 * IndexedDB projection mirror (Node has no IndexedDB; the LWW-by-`seq` rules of
 * PROTOCOL.md §2.1 are applied identically).
 *
 * Everything on the wire goes through `kernel/src/protocol.ts` and
 * `kernel/src/sync/transport.ts` — the same code the browser runs. A faked
 * transport would prove nothing about convergence, which is the whole point of
 * this harness (`web/CONTRACTS.md`, area web-harness).
 *
 * The recovery moves are the protocol's, not invented here:
 * `feed.reset` → REST bootstrap then re-subscribe at the pinned `safe_seq`;
 * `feed.resync` → re-subscribe at `from_seq`, keeping every row;
 * `doc.resync` → a fresh `SYNC_STEP1` per document;
 * `doc.error { too_large, hint: "rest" }` → hydrate over REST, re-subscribe with
 * the resulting state vector.
 */

import * as Y from "yjs";

import {
  FrameType,
  PROTOCOL_VERSION,
  type BinaryFrame,
  type FeedRow,
  type ServerControl,
  type Welcome,
} from "../../kernel/src/protocol.js";
import { SyncTransport } from "../../kernel/src/sync/transport.js";
import { applyOp, chooseOp, markersIn, TEXT_ROOT, type OpKind, type OpRecord } from "./ops.js";
import { bytesToBase64, RestClient } from "./rest.js";
import type { SimulatedClient } from "./scenario.js";

/** Origin tag for remotely-applied updates, so the local handler ignores them. */
const REMOTE = Symbol("remote");

export interface SimClientOptions {
  readonly name: string;
  readonly token: string;
  readonly baseUrl: string;
  /**
   * Per-run tag mixed into this client's markers. Document ids are deterministic,
   * so two runs edit the same documents; without a tag, run 2's `{{c1#1}}` collides
   * with run 1's leftover and "every marker appears exactly once" reports a
   * duplicate that is really just history.
   */
  readonly tag?: string;
  /** Subscribe to the workspace change feed as well as documents. */
  readonly feed?: boolean;
  readonly log?: (line: string) => void;
}

export interface ClientStats {
  connects: number;
  closes: { code: number; reason: string }[];
  updatesSent: number;
  updatesReceived: number;
  step1Sent: number;
  step2Sent: number;
  /** Local transactions produced while the socket was down (the offline queue). */
  offlineUpdates: number;
  docResyncs: number;
  feedResets: number;
  feedResyncs: number;
  feedRows: number;
  restHydrations: number;
  awarenessRelayed: number;
  errors: string[];
}

interface DocEntry {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  subscribed: boolean;
  /** Resolved when `doc.subscribed` + the server's `SYNC_STEP1` have arrived. */
  ready?: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
  sawServerStep1: boolean;
  /** Markers this client wrote into this document, in order. */
  markers: string[];
  opCount: number;
  queuedWhileOffline: number;
  /** Created locally while offline and not yet POSTed to the server. */
  pendingCreate: boolean;
}

export class HarnessClient implements SimulatedClient {
  readonly name: string;
  readonly token: string;
  readonly rest: RestClient;
  readonly stats: ClientStats = {
    connects: 0,
    closes: [],
    updatesSent: 0,
    updatesReceived: 0,
    step1Sent: 0,
    step2Sent: 0,
    offlineUpdates: 0,
    docResyncs: 0,
    feedResets: 0,
    feedResyncs: 0,
    feedRows: 0,
    restHydrations: 0,
    awarenessRelayed: 0,
    errors: [],
  };

  /** The client's projection mirror: LWW by `seq` (PROTOCOL.md §2.1). */
  readonly projection = new Map<string, FeedRow>();
  /** The persisted resume point: the server's `safe_seq`, never `max(seq)` seen. */
  safeSeq = 0;
  headSeq = 0;
  feedComplete = false;
  welcome: Welcome | undefined;

  #transport: SyncTransport | undefined;
  #docs = new Map<string, DocEntry>();
  #welcomeWaiters: { resolve: (welcome: Welcome) => void; reject: (error: Error) => void }[] = [];
  #closed = false;

  constructor(private readonly options: SimClientOptions) {
    this.name = options.name;
    this.token = options.token;
    this.rest = new RestClient(options.baseUrl, options.token);
  }

  get connected(): boolean {
    return this.#transport?.state === "open";
  }

  get documentIds(): string[] {
    return [...this.#docs.keys()];
  }

  markersOf(id: string): readonly string[] {
    return this.#docs.get(id)?.markers ?? [];
  }

  opsOn(id: string): number {
    return this.#docs.get(id)?.opCount ?? 0;
  }

  // -- connection ----------------------------------------------------------

  async connect(): Promise<void> {
    if (this.connected) return;
    this.#closed = false;
    const transport = new SyncTransport(
      {
        url: new URL("/api/sync", this.options.baseUrl).toString(),
        bearerToken: this.token,
        socketFactory: (url, protocols) => new WebSocket(url, protocols) as unknown as WebSocket,
      },
      {
        onControl: (message) => this.#onControl(message),
        onBinary: (frame) => this.#onBinary(frame),
        onClose: (code, reason) => {
          this.stats.closes.push({ code, reason });
          for (const entry of this.#docs.values()) {
            entry.subscribed = false;
            entry.sawServerStep1 = false;
            entry.ready = undefined;
          }
          this.feedComplete = false;
          this.#rejectWelcomeWaiters(new Error(`socket closed: ${code} ${reason}`));
        },
        onError: (error) => {
          this.stats.errors.push(error.message);
        },
      },
    );
    this.#transport = transport;
    await transport.connect();
    this.stats.connects += 1;

    const welcome = await this.#awaitWelcome(10_000);
    if (welcome.protocol !== PROTOCOL_VERSION) {
      throw new Error(`server speaks protocol ${welcome.protocol}, harness speaks ${PROTOCOL_VERSION}`);
    }

    if (this.options.feed !== false) this.#subscribeFeed(this.safeSeq);
    for (const entry of this.#docs.values()) {
      if (!entry.pendingCreate) this.#beginSubscribe(entry);
    }
  }

  /**
   * Drop the socket — a partition.
   *
   * The default code is **4000**, not `1001`: the WebSocket API only lets a client
   * close with `1000` or `3000–4999` (undici raises `InvalidAccessError` on
   * anything else, and browsers agree), and `4000` is unused by PROTOCOL.md §7. A
   * failure here must never take the run down, so it is caught: the point of a
   * partition is that the socket goes away, not how politely.
   */
  disconnect(code = 4000): void {
    try {
      this.#transport?.close(code, "harness partition");
    } catch (error) {
      this.stats.errors.push(`close(${code}): ${String(error)}`);
    }
    this.#transport = undefined;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.disconnect(1000);
    for (const entry of this.#docs.values()) entry.doc.destroy();
    this.#docs.clear();
  }

  #awaitWelcome(timeoutMs: number): Promise<Welcome> {
    if (this.welcome && this.connected) return Promise.resolve(this.welcome);
    return new Promise<Welcome>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no `welcome` frame within the deadline")), timeoutMs);
      this.#welcomeWaiters.push({
        resolve: (welcome) => {
          clearTimeout(timer);
          resolve(welcome);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  #rejectWelcomeWaiters(error: Error): void {
    const waiters = this.#welcomeWaiters;
    this.#welcomeWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  // -- documents -----------------------------------------------------------

  /** Open a document for editing: hydrate lazily over the socket (SPEC §4.1). */
  async open(id: string): Promise<Y.Text> {
    const entry = this.#entry(id);
    if (this.connected && !entry.pendingCreate) await this.#subscribeAndWait(entry, 15_000);
    return entry.text;
  }

  /**
   * Mint a document **offline**: a client-side ULID and a local replica, with no
   * server round trip (SPEC §3.5 "client-mintable offline"). The create is
   * flushed by {@link flushPendingCreates} on reconnect — M2 has no create
   * message on the socket, so that flush is a REST `POST`.
   */
  createOffline(id: string, text: string): Y.Text {
    const entry = this.#entry(id);
    entry.pendingCreate = true;
    entry.doc.transact(() => {
      entry.text.insert(0, text);
    });
    entry.markers.push(...markersIn(text));
    return entry.text;
  }

  /** POST every offline-created document, then hydrate it from the server. */
  async flushPendingCreates(): Promise<string[]> {
    const flushed: string[] = [];
    for (const entry of [...this.#docs.values()]) {
      if (!entry.pendingCreate) continue;
      const text = entry.text.toString();
      await this.rest.createDocument(entry.id, text);
      // The server minted its own CRDT history for this text. Drop the local
      // replica rather than merging two independent histories of the same
      // characters (that would duplicate the text), and re-hydrate from the
      // server — the markers are already on the server side.
      entry.doc.destroy();
      this.#docs.delete(entry.id);
      const fresh = this.#entry(entry.id);
      fresh.markers = entry.markers;
      fresh.opCount = entry.opCount;
      if (this.connected) await this.#subscribeAndWait(fresh, 15_000);
      flushed.push(entry.id);
    }
    return flushed;
  }

  /** Apply one randomized operation (`ops.ts`) to an open document. */
  async edit(id: string, rng: () => number): Promise<void> {
    this.editSync(id, rng);
  }

  /** The name markers carry: the client plus this run's tag. */
  get markerName(): string {
    return this.options.tag ? `${this.name}-${this.options.tag}` : this.name;
  }

  /** The synchronous form, which also returns what it did (for the journal). */
  editSync(id: string, rng: () => number, kind: OpKind = chooseOp(rng)): OpRecord {
    const entry = this.#entry(id);
    entry.opCount += 1;
    const record = applyOp(entry.text, id, this.markerName, entry.opCount, rng, kind);
    if (record.marker && record.applied) entry.markers.push(record.marker);
    return record;
  }

  textOf(id: string): string | undefined {
    const entry = this.#docs.get(id);
    return entry ? entry.text.toString() : undefined;
  }

  /**
   * Wait until this client's replica of `id` is byte-identical to the server's
   * CRDT state. Both directions have to flow: the server's reads come over the
   * socket, and the client's writes are pushed by the `SYNC_STEP1`/`SYNC_STEP2`
   * handshake a (re)subscribe performs.
   */
  async awaitConvergence(id: string, timeoutMs: number): Promise<void> {
    const entry = this.#docs.get(id);
    if (!entry) throw new Error(`${this.name} has no replica of ${id}`);
    const deadline = Date.now() + timeoutMs;
    let nudged = false;

    for (;;) {
      if (!this.connected && !this.#closed) await this.connect();
      if (entry.pendingCreate) await this.flushPendingCreates();
      if (this.connected && !entry.subscribed) await this.#subscribeAndWait(entry, 10_000);

      const local = this.textOf(id);
      const server = await this.#serverText(id);
      if (local !== undefined && local === server) return;

      if (Date.now() > deadline) {
        throw new ConvergenceTimeout(this.name, id, local ?? "", server);
      }
      if (!nudged && Date.now() > deadline - (timeoutMs * 2) / 3) {
        // One state-vector resync, the universal recovery move (PROTOCOL.md §3.5).
        this.#sendStep1(entry);
        nudged = true;
      }
      await sleep(120);
    }
  }

  /** The server's text for `id`, decoded from its CRDT state (never materialized). */
  async #serverText(id: string): Promise<string> {
    const { state } = await this.rest.crdtState(id);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const text = doc.getText(TEXT_ROOT).toString();
    doc.destroy();
    return text;
  }

  #entry(id: string): DocEntry {
    const existing = this.#docs.get(id);
    if (existing) return existing;
    const doc = new Y.Doc();
    const text = doc.getText(TEXT_ROOT);
    const entry: DocEntry = {
      id,
      doc,
      text,
      subscribed: false,
      sawServerStep1: false,
      markers: [],
      opCount: 0,
      queuedWhileOffline: 0,
      pendingCreate: false,
    };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      if (this.connected && entry.subscribed) {
        this.#send({ type: FrameType.Update, docId: id, payload: update });
        this.stats.updatesSent += 1;
      } else {
        // Offline queue: the CRDT *is* the queue. Nothing is sent; the next
        // subscribe's SYNC_STEP2 carries everything the server is missing.
        entry.queuedWhileOffline += 1;
        this.stats.offlineUpdates += 1;
      }
    });
    this.#docs.set(id, entry);
    return entry;
  }

  async #subscribeAndWait(entry: DocEntry, timeoutMs: number): Promise<void> {
    if (entry.subscribed && entry.sawServerStep1) return;
    this.#beginSubscribe(entry);
    const ready = entry.ready;
    if (!ready) return;
    await withTimeout(
      ready.promise,
      timeoutMs,
      `${this.name}: ${entry.id} did not finish its sync handshake in ${timeoutMs} ms`,
    );
  }

  /** Send `doc.subscribe` once per socket per document, tracking its handshake. */
  #beginSubscribe(entry: DocEntry): void {
    if (!this.connected) return;
    if (entry.ready) return;
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolveFn, rejectFn) => {
      resolve = resolveFn;
      reject = rejectFn;
    });
    entry.ready = { promise, resolve, reject };
    this.#sendSubscribe(entry);
  }

  #sendSubscribe(entry: DocEntry): void {
    if (!this.connected) return;
    // Always send `sv`: with an empty state vector the server answers
    // `SYNC_STEP2` with everything it has, which is the no-local-replica path of
    // PROTOCOL.md §3.3 in one round trip.
    const sv = bytesToBase64(Y.encodeStateVector(entry.doc));
    this.#transport?.sendControl({ t: "doc.subscribe", id: entry.id, sv });
  }

  #subscribeFeed(sinceSeq: number): void {
    this.#transport?.sendControl({
      t: "feed.subscribe",
      since_seq: sinceSeq,
      include_content: true,
      batch_max_rows: 200,
    });
  }

  #send(frame: BinaryFrame): void {
    if (!this.connected) return;
    try {
      this.#transport?.sendBinary(frame);
    } catch (error) {
      this.stats.errors.push(`send ${frame.type}: ${String(error)}`);
    }
  }

  #sendStep1(entry: DocEntry | undefined): void {
    if (!entry || !this.connected) return;
    this.#send({
      type: FrameType.SyncStep1,
      docId: entry.id,
      payload: Y.encodeStateVector(entry.doc),
    });
    this.stats.step1Sent += 1;
  }

  // -- inbound -------------------------------------------------------------

  #onControl(message: ServerControl): void {
    switch (message.t) {
      case "welcome": {
        this.welcome = message;
        this.headSeq = message.feed.head_seq;
        const waiters = this.#welcomeWaiters;
        this.#welcomeWaiters = [];
        for (const waiter of waiters) waiter.resolve(message);
        return;
      }
      case "feed.batch": {
        this.#applyFeedRows(message.rows);
        // The watermark is the server's `safe_seq`, never the largest `seq` seen
        // (PROTOCOL.md §2.2) — storing `max(seq)` skips slower commits forever.
        this.safeSeq = Math.max(this.safeSeq, message.safe_seq);
        this.headSeq = Math.max(this.headSeq, message.head_seq);
        if (message.complete) this.feedComplete = true;
        return;
      }
      case "feed.reset": {
        this.stats.feedResets += 1;
        void this.#bootstrapThenResubscribe();
        return;
      }
      case "feed.resync": {
        this.stats.feedResyncs += 1;
        this.#subscribeFeed(message.from_seq);
        return;
      }
      case "doc.subscribed": {
        const entry = this.#docs.get(message.id);
        if (!entry) return;
        entry.subscribed = true;
        if (entry.sawServerStep1) entry.ready?.resolve();
        return;
      }
      case "doc.resync": {
        this.stats.docResyncs += 1;
        const targets = message.id ? [this.#docs.get(message.id)] : [...this.#docs.values()];
        for (const entry of targets) this.#sendStep1(entry);
        return;
      }
      case "doc.error": {
        const entry = this.#docs.get(message.id);
        if (message.code === "too_large" && message.hint === "rest" && entry) {
          void this.#hydrateOverRest(entry);
          return;
        }
        this.stats.errors.push(`doc.error ${message.id} ${message.code}: ${message.message}`);
        entry?.ready?.reject(new Error(`doc.error ${message.code}`));
        return;
      }
      case "error": {
        this.stats.errors.push(`server error ${message.code}: ${message.message}`);
        return;
      }
      default:
        return;
    }
  }

  #applyFeedRows(rows: readonly FeedRow[]): void {
    for (const row of rows) {
      this.stats.feedRows += 1;
      // PROTOCOL.md §2.1: every timestamp on the feed is an RFC 3339 string.
      if (typeof row.updated_at !== "string" || typeof row.created_at !== "string") {
        const violation = `feed row ${row.id} carries a non-string timestamp (extended JSON?)`;
        if (!this.stats.errors.includes(violation)) this.stats.errors.push(violation);
      }
      const stored = this.projection.get(row.id);
      if (stored && stored.seq >= row.seq) continue; // LWW by seq; older rows ignored
      if (row.purged) {
        this.projection.delete(row.id);
        const entry = this.#docs.get(row.id);
        if (entry) {
          entry.doc.destroy();
          this.#docs.delete(row.id);
        }
        continue;
      }
      this.projection.set(row.id, row);
    }
  }

  async #bootstrapThenResubscribe(): Promise<void> {
    try {
      const measurement = await this.rest.bootstrap({
        onRow: (row) => this.#applyFeedRows([row]),
      });
      this.safeSeq = measurement.safeSeq;
      this.#subscribeFeed(this.safeSeq);
    } catch (error) {
      this.stats.errors.push(`bootstrap after feed.reset: ${String(error)}`);
    }
  }

  async #hydrateOverRest(entry: DocEntry): Promise<void> {
    try {
      const { state } = await this.rest.crdtState(entry.id);
      Y.applyUpdate(entry.doc, state, REMOTE);
      this.stats.restHydrations += 1;
      this.#sendSubscribe(entry);
    } catch (error) {
      this.stats.errors.push(`rest hydration of ${entry.id}: ${String(error)}`);
    }
  }

  #onBinary(frame: BinaryFrame): void {
    const entry = this.#docs.get(frame.docId);
    if (!entry) return;
    switch (frame.type) {
      case FrameType.SyncStep1: {
        entry.sawServerStep1 = true;
        try {
          const diff = Y.encodeStateAsUpdate(entry.doc, frame.payload);
          this.#send({ type: FrameType.SyncStep2, docId: frame.docId, payload: diff });
          this.stats.step2Sent += 1;
        } catch (error) {
          this.stats.errors.push(`SYNC_STEP1 for ${frame.docId}: ${String(error)}`);
        }
        if (entry.subscribed) entry.ready?.resolve();
        return;
      }
      case FrameType.SyncStep2:
      case FrameType.Update: {
        try {
          Y.applyUpdate(entry.doc, frame.payload, REMOTE);
          this.stats.updatesReceived += 1;
        } catch (error) {
          this.stats.errors.push(`apply update for ${frame.docId}: ${String(error)}`);
        }
        return;
      }
      case FrameType.Awareness: {
        // Relayed opaquely, never parsed (SPEC §3.2). Counted, and nothing else.
        this.stats.awarenessRelayed += 1;
        return;
      }
      default:
        return; // unknown types ≥ 0x10 are ignored (PROTOCOL.md §3.1)
    }
  }
}

export class ConvergenceTimeout extends Error {
  constructor(
    readonly client: string,
    readonly documentId: string,
    readonly localText: string,
    readonly serverText: string,
  ) {
    super(
      `${client} never converged on ${documentId}: local ${localText.length} chars, ` +
        `server ${serverText.length} chars`,
    );
    this.name = "ConvergenceTimeout";
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a promise against a deadline, clearing the timer either way. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
