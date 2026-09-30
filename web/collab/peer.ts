/**
 * One collaborator: a session, the kernel's real {@link SyncTransport} over a real
 * WebSocket, and real `Y.Doc` replicas. It speaks the client half of
 * `backend/PROTOCOL.md` the way the app does, and nothing more clever:
 *
 * - the CRDT is the offline queue: edits land in the replica whatever the socket is
 *   doing, and the next subscribe's `SYNC_STEP1`/`SYNC_STEP2` carries what the server
 *   is missing (§3.3);
 * - a note made on the device is created from its CRDT state (§3.8), and a create
 *   answered `409` is checked against the server's state vector before it is claimed;
 * - a socket the server drops is reconnected, as the app's backoff does (§8), unless
 *   the test put the peer {@link Peer.offline | offline} on purpose.
 *
 * On top of that it can misbehave on command, which is what the suite is for:
 * {@link Peer.latency} delays both directions so edits cross in flight, and
 * {@link Peer.offline} cuts the socket with whatever was in flight still in it.
 */

import * as Y from "yjs";

import { FrameType, type BinaryFrame, type ServerControl, type Welcome } from "../kernel/src/protocol.js";
import { SyncTransport } from "../kernel/src/sync/transport.js";
import { mintUlid } from "../harness/src/core.js";
import { TEXT_ROOT } from "../harness/src/ops.js";
import { base64ToBytes, bytesToBase64, RestClient } from "../harness/src/rest.js";

const REMOTE = Symbol("remote");

export interface DocErrorSeen {
  readonly code: string;
  readonly message: string;
}

interface Replica {
  readonly id: string;
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  subscribed: boolean;
  sawStep1: boolean;
  ready?: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void };
  /** Made on this device and not yet accepted by the server (§3.8). */
  pendingCreate: boolean;
  /** The state vector the create was minted with: what "this note is ours" means. */
  seedSv?: Uint8Array;
  errors: DocErrorSeen[];
}

/** What survives closing the tab: the replicas and which of them wait to be created. */
export interface PersistedPeer {
  readonly docs: readonly { id: string; state: Uint8Array; pendingCreate: boolean; seedSv?: Uint8Array }[];
}

export class Peer {
  readonly rest: RestClient;
  /** A note made here whose id turned out to be someone else's: old id → new id. */
  readonly forks = new Map<string, string>();
  /** Closes the server or the network caused (not the ones this peer asked for). */
  readonly closes: { code: number; reason: string }[] = [];
  /** Sockets that got as far as `welcome`. */
  connects = 0;
  readonly errors: string[] = [];
  welcome: Welcome | undefined;

  #transport: SyncTransport | undefined;
  #docs = new Map<string, Replica>();
  #wantOnline = false;
  #reconnecting = false;
  #welcomeWaiter: ((welcome: Welcome) => void) | undefined;
  #latencyMs = 0;
  /** Bumped on every socket, so a delayed frame never lands on the next one. */
  #epoch = 0;

  constructor(
    readonly name: string,
    readonly baseUrl: string,
    readonly token: string,
  ) {
    this.rest = new RestClient(baseUrl, token);
  }

  get connected(): boolean {
    return this.#transport?.state === "open" && this.welcome !== undefined;
  }

  /** Delay every frame, both ways, by this long. Order is kept; nothing is dropped. */
  latency(ms: number): void {
    this.#latencyMs = ms;
  }

  // -- connection -----------------------------------------------------------

  /** Connect, create what waits to be created, and resubscribe every replica. */
  async online(timeoutMs = 20_000): Promise<void> {
    this.#wantOnline = true;
    await this.#sync(timeoutMs);
  }

  async #sync(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.connected) {
      try {
        await this.#connectOnce();
      } catch (error) {
        if (Date.now() > deadline) throw new Error(`${this.name} could not connect: ${String(error)}`);
        await sleep(150);
      }
    }
    await this.flushCreates();
    // `allSettled`: a note deleted for good answers `gone`, which is that note's
    // outcome (see `docErrors`), not a failure to come online.
    await Promise.allSettled(
      [...this.#docs.values()].filter((r) => !r.pendingCreate).map((r) => this.#handshake(r)),
    );
  }

  /** Cut the socket now, with whatever was in flight still in it, and stay off. */
  offline(): void {
    this.#wantOnline = false;
    this.#drop("collab: offline");
  }

  /** Lose the socket as a flaky network does: the peer notices and reconnects. */
  blip(): void {
    this.#drop("collab: blip");
  }

  async close(): Promise<void> {
    this.offline();
    for (const replica of this.#docs.values()) replica.doc.destroy();
    this.#docs.clear();
  }

  async #connectOnce(): Promise<void> {
    this.welcome = undefined;
    const epoch = ++this.#epoch;
    const transport = new SyncTransport(
      {
        url: new URL("/api/sync", this.baseUrl).toString(),
        bearerToken: this.token,
        socketFactory: (url, protocols) => new WebSocket(url, protocols) as unknown as WebSocket,
      },
      {
        onControl: (message) => this.#inbound(epoch, () => this.#onControl(message)),
        onBinary: (frame) => this.#inbound(epoch, () => this.#onBinary(frame)),
        onClose: (code, reason) => {
          if (epoch !== this.#epoch) return;
          this.closes.push({ code, reason });
          this.#lost();
        },
        onError: (error) => this.errors.push(error.message),
      },
    );
    this.#transport = transport;
    const welcomed = new Promise<Welcome>((resolve, reject) => {
      this.#welcomeWaiter = resolve;
      setTimeout(() => reject(new Error("no welcome within 10 s")), 10_000);
    });
    await transport.connect();
    await welcomed;
  }

  #drop(reason: string): void {
    const transport = this.#transport;
    this.#transport = undefined;
    this.#epoch += 1;
    try {
      transport?.close(4000, reason);
    } catch (error) {
      this.errors.push(`close: ${String(error)}`);
    }
    this.#lost();
  }

  /** The socket is gone: every handshake has to be redone, and maybe we reconnect. */
  #lost(): void {
    this.welcome = undefined;
    for (const replica of this.#docs.values()) {
      replica.subscribed = false;
      replica.sawStep1 = false;
      replica.ready?.reject(new Error("socket closed"));
      replica.ready = undefined;
    }
    if (this.#wantOnline && !this.#reconnecting) {
      this.#reconnecting = true;
      void (async () => {
        await sleep(100);
        while (this.#wantOnline && !this.connected) {
          try {
            await this.#sync(5_000);
          } catch {
            await sleep(250);
          }
        }
        this.#reconnecting = false;
      })();
    }
  }

  // -- documents ------------------------------------------------------------

  /** Open a note: a replica, hydrated over the socket when online. */
  async open(id: string): Promise<Y.Text> {
    const replica = this.#replica(id);
    if (this.connected && !replica.pendingCreate) await this.#handshake(replica);
    return replica.text;
  }

  /** Make a note on this device (§3.8). Online it is created at once; offline it waits. */
  async create(content: string, id: string = mintUlid(Math.random, Date.now())): Promise<string> {
    const replica = this.#replica(id);
    replica.pendingCreate = true;
    replica.doc.transact(() => replica.text.insert(0, content));
    replica.seedSv = Y.encodeStateVector(replica.doc);
    if (this.connected) await this.flushCreates();
    return id;
  }

  /** Send every waiting create. A `409` is ours only if the server holds our seed. */
  async flushCreates(): Promise<void> {
    for (const replica of [...this.#docs.values()]) {
      if (!replica.pendingCreate) continue;
      const state = bytesToBase64(Y.encodeStateAsUpdate(replica.doc));
      const response = await this.rest.request("POST", "/api/documents", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: replica.id, state }),
      }).catch((error: unknown) => error);
      const status = response instanceof Response ? response.status : (response as { status?: number }).status;
      if (response instanceof Response) await response.arrayBuffer();
      if (status === 201 || (status === 409 && (await this.#serverHoldsSeed(replica)))) {
        replica.pendingCreate = false;
        if (this.connected) await this.#handshake(replica);
        continue;
      }
      if (status === 409) {
        // Someone else's note has this id: ours becomes a new note, text and all.
        const fresh = mintUlid(Math.random, Date.now());
        this.#docs.delete(replica.id);
        const moved = this.#replica(fresh);
        Y.applyUpdate(moved.doc, Y.encodeStateAsUpdate(replica.doc), REMOTE);
        moved.pendingCreate = true;
        moved.seedSv = Y.encodeStateVector(moved.doc);
        this.forks.set(replica.id, fresh);
        replica.doc.destroy();
        await this.flushCreates();
        return;
      }
      throw new Error(`${this.name}: create ${replica.id} answered ${String(status)}`);
    }
  }

  /** Pretend the reply to this note's create was lost: the next flush sends it again. */
  loseCreateReply(id: string): void {
    this.#require(id).pendingCreate = true;
  }

  async #serverHoldsSeed(replica: Replica): Promise<boolean> {
    const { stateVector } = await this.rest.crdtState(replica.id);
    const server = Y.decodeStateVector(stateVector);
    for (const [client, clock] of Y.decodeStateVector(replica.seedSv ?? new Uint8Array([0]))) {
      if ((server.get(client) ?? 0) < clock) return false;
    }
    return true;
  }

  text(id: string): string {
    const replica = this.#docs.get(id);
    if (!replica) throw new Error(`${this.name} has no replica of ${id}`);
    return replica.text.toString();
  }

  has(id: string): boolean {
    return this.#docs.has(id);
  }

  docErrors(id: string): readonly DocErrorSeen[] {
    return this.#docs.get(id)?.errors ?? [];
  }

  insert(id: string, index: number, content: string): void {
    const replica = this.#require(id);
    replica.doc.transact(() => replica.text.insert(index, content));
  }

  delete(id: string, index: number, length: number): void {
    const replica = this.#require(id);
    replica.doc.transact(() => replica.text.delete(index, length));
  }

  append(id: string, content: string): void {
    this.insert(id, this.text(id).length, content);
  }

  /** Insert right after the first occurrence of `anchor` (throws if it is not there). */
  insertAfter(id: string, anchor: string, content: string): void {
    const at = this.text(id).indexOf(anchor);
    if (at < 0) throw new Error(`${this.name}: "${anchor}" is not in ${id}`);
    this.insert(id, at + anchor.length, content);
  }

  /** Replace the first occurrence of `find`, as a minimal delete + insert. */
  replace(id: string, find: string, replacement: string): void {
    const replica = this.#require(id);
    const at = replica.text.toString().indexOf(find);
    if (at < 0) throw new Error(`${this.name}: "${find}" is not in ${id}`);
    replica.doc.transact(() => {
      replica.text.delete(at, find.length);
      replica.text.insert(at, replacement);
    });
  }

  /**
   * Type `content` one character per transaction, as a keyboard does: the caret is a
   * relative position that stays after the last character typed, so other people's
   * edits move it the way they move a real caret.
   */
  async type(id: string, index: number, content: string, gapMs = 0): Promise<void> {
    const replica = this.#require(id);
    let caret = Y.createRelativePositionFromTypeIndex(replica.text, index, -1);
    for (const char of content) {
      const at = Y.createAbsolutePositionFromRelativePosition(caret, replica.doc)?.index ?? replica.text.length;
      replica.doc.transact(() => replica.text.insert(at, char));
      caret = Y.createRelativePositionFromTypeIndex(replica.text, at + 1, -1);
      if (gapMs > 0) await sleep(gapMs);
    }
  }

  yText(id: string): Y.Text {
    return this.#require(id).text;
  }

  /** Nudge a document the way `doc.resync` does: a fresh `SYNC_STEP1`. */
  resync(id: string): void {
    const replica = this.#docs.get(id);
    if (replica && this.connected) {
      this.#send({ type: FrameType.SyncStep1, docId: id, payload: Y.encodeStateVector(replica.doc) });
    }
  }

  /** What IndexedDB would hold if the tab closed now. */
  persist(): PersistedPeer {
    return {
      docs: [...this.#docs.values()].map((replica) => ({
        id: replica.id,
        state: Y.encodeStateAsUpdate(replica.doc),
        pendingCreate: replica.pendingCreate,
        ...(replica.seedSv ? { seedSv: replica.seedSv } : {}),
      })),
    };
  }

  /** Reopen from a {@link persist}: a new tab on the same device, still offline. */
  static revive(name: string, baseUrl: string, token: string, saved: PersistedPeer): Peer {
    const peer = new Peer(name, baseUrl, token);
    for (const doc of saved.docs) {
      const replica = peer.#replica(doc.id);
      Y.applyUpdate(replica.doc, doc.state, REMOTE);
      replica.pendingCreate = doc.pendingCreate;
      if (doc.seedSv) replica.seedSv = doc.seedSv;
    }
    return peer;
  }

  #require(id: string): Replica {
    const replica = this.#docs.get(id);
    if (!replica) throw new Error(`${this.name} has not opened ${id}`);
    return replica;
  }

  #replica(id: string): Replica {
    const existing = this.#docs.get(id);
    if (existing) return existing;
    const doc = new Y.Doc();
    const replica: Replica = {
      id,
      doc,
      text: doc.getText(TEXT_ROOT),
      subscribed: false,
      sawStep1: false,
      pendingCreate: false,
      errors: [],
    };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || !replica.subscribed) return;
      this.#send({ type: FrameType.Update, docId: id, payload: update });
    });
    this.#docs.set(id, replica);
    return replica;
  }

  async #handshake(replica: Replica): Promise<void> {
    if (replica.subscribed && replica.sawStep1) return;
    if (!replica.ready) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      promise.catch(() => undefined);
      replica.ready = { promise, resolve, reject };
      this.#control({ t: "doc.subscribe", id: replica.id, sv: bytesToBase64(Y.encodeStateVector(replica.doc)) });
    }
    await withTimeout(replica.ready.promise, 15_000, `${this.name}: no handshake for ${replica.id}`);
  }

  // -- the wire -------------------------------------------------------------

  #control(message: Parameters<SyncTransport["sendControl"]>[0]): void {
    this.#later(() => this.#transport?.sendControl(message));
  }

  #send(frame: BinaryFrame): void {
    this.#later(() => this.#transport?.sendBinary(frame));
  }

  /** Outbound: now, or after the latency — and only on the socket it was meant for. */
  #later(send: () => void): void {
    const epoch = this.#epoch;
    const go = () => {
      if (epoch !== this.#epoch || this.#transport?.state !== "open") return;
      try {
        send();
      } catch (error) {
        this.errors.push(`send: ${String(error)}`);
      }
    };
    if (this.#latencyMs > 0) setTimeout(go, this.#latencyMs);
    else go();
  }

  #inbound(epoch: number, handle: () => void): void {
    const go = () => {
      if (epoch === this.#epoch) handle();
    };
    if (this.#latencyMs > 0) setTimeout(go, this.#latencyMs);
    else go();
  }

  #onControl(message: ServerControl): void {
    switch (message.t) {
      case "welcome":
        this.welcome = message;
        this.connects += 1;
        this.#welcomeWaiter?.(message);
        this.#welcomeWaiter = undefined;
        return;
      case "doc.subscribed": {
        const replica = this.#docs.get(message.id);
        if (!replica) return;
        replica.subscribed = true;
        if (replica.sawStep1) replica.ready?.resolve();
        return;
      }
      case "doc.resync": {
        const targets = message.id ? [message.id] : [...this.#docs.keys()];
        for (const id of targets) this.resync(id);
        return;
      }
      case "doc.error": {
        const replica = this.#docs.get(message.id);
        replica?.errors.push({ code: message.code, message: message.message });
        if (message.code === "too_large" && message.hint === "rest" && replica) {
          void this.rest.crdtState(replica.id).then(({ state }) => {
            Y.applyUpdate(replica.doc, state, REMOTE);
            this.#control({ t: "doc.subscribe", id: replica.id, sv: bytesToBase64(Y.encodeStateVector(replica.doc)) });
          });
          return;
        }
        replica?.ready?.reject(new Error(`doc.error ${message.code}: ${message.message}`));
        if (replica) replica.ready = undefined;
        return;
      }
      case "error":
        this.errors.push(`server error ${message.code}: ${message.message}`);
        return;
      default:
        return;
    }
  }

  #onBinary(frame: BinaryFrame): void {
    const replica = this.#docs.get(frame.docId);
    if (!replica) return;
    switch (frame.type) {
      case FrameType.SyncStep1: {
        replica.sawStep1 = true;
        this.#send({
          type: FrameType.SyncStep2,
          docId: frame.docId,
          payload: Y.encodeStateAsUpdate(replica.doc, frame.payload),
        });
        if (replica.subscribed) replica.ready?.resolve();
        return;
      }
      case FrameType.SyncStep2:
      case FrameType.Update:
        try {
          Y.applyUpdate(replica.doc, frame.payload, REMOTE);
        } catch (error) {
          this.errors.push(`apply ${frame.docId}: ${String(error)}`);
        }
        return;
      default:
        return;
    }
  }
}

export { base64ToBytes };

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
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
