/**
 * Lazy hydration, the LRU, and offline editing (SPEC §4.1, PROTOCOL.md §3).
 *
 * The scenario that matters most is the last one in this file: open a document,
 * lose the socket, keep typing, reconnect — and have the server end up with the
 * text without anyone replaying a remembered frame.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
  DocHydrator,
  TEXT_ROOT,
  type DocHydratorOptions,
  type HydratedDoc,
} from "./doc-hydration.js";
import { SyncTransport } from "./transport.js";
import { MockSocket, ServerDoc, settle } from "./testing.js";
import { MemoryDocPersistence } from "../store/testing.js";
import { FrameType, type DocError } from "../protocol.js";

const DOC = "01J8ZQ0M3M4YQV0X0PTN9R2G7C";
const OTHER = "01J8ZQ0M3M4YQV0X0PTN9R2G7D";
const THIRD = "01J8ZQ0M3M4YQV0X0PTN9R2G7E";

const transports: SyncTransport[] = [];

afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
  MockSocket.reset();
});

/**
 * A transport wired to a hydrator the way `SyncClient` wires it: binary frames
 * straight through, `doc.subscribed` / `doc.error` routed to their handlers.
 * The hydrator does not register itself, so the routing table is part of what
 * these tests exercise.
 */
function makeTransport(): { transport: SyncTransport; attach: (hydrator: DocHydrator) => void } {
  let attached: DocHydrator | undefined;
  const transport = new SyncTransport(
    {
      url: "ws://127.0.0.1:8080/api/sync",
      socketFactory: MockSocket.factory,
      heartbeatMs: 3_600_000,
    },
    {
      onBinary: (frame) => attached?.onBinary(frame),
      onControl: (message) => {
        if (message.t === "doc.subscribed") attached?.onSubscribed(message);
        if (message.t === "doc.error") attached?.onDocError(message);
        if (message.t === "doc.resync") attached?.onResync(message);
      },
    },
  );
  transports.push(transport);
  return {
    transport,
    attach: (hydrator) => {
      attached = hydrator;
    },
  };
}

async function connect(transport: SyncTransport): Promise<MockSocket> {
  const opening = transport.connect();
  MockSocket.last.open();
  await opening;
  return MockSocket.last;
}

/**
 * A hydrator wired to a live mock socket, with the server half of the handshake
 * automated: the client's `SYNC_STEP1` is answered with a `SYNC_STEP2`, and its
 * updates are applied to a server-side Y.Doc, exactly as the sync route does.
 */
async function fixture(options: DocHydratorOptions = {}, docs: string[] = [DOC]) {
  MockSocket.reset();
  const { transport, attach } = makeTransport();
  const socket = await connect(transport);
  const hydrator = new DocHydrator(transport, { syncTimeoutMs: 200, ...options });
  attach(hydrator);
  const server = new Map(docs.map((id) => [id, new ServerDoc(id)]));

  /** Play the server: ack the subscribe, answer step 1, apply updates. */
  const serve = (): void => {
    for (const frame of socket.sentBinary.splice(0)) {
      const doc = server.get(frame.docId);
      if (!doc) continue;
      if (frame.type === FrameType.SyncStep1) {
        socket.deliverBinary(doc.step2(frame.payload));
        continue;
      }
      if (frame.type === FrameType.SyncStep2 || frame.type === FrameType.Update) {
        doc.apply(frame);
      }
    }
    for (const message of socket.sentControl.filter((m) => m.t === "doc.subscribe")) {
      socket.deliver({
        t: "doc.subscribed",
        id: (message as { id: string }).id,
        materialized_version: "v1",
        updated_at: "2026-09-24T09:00:00.000Z",
        deleted: false,
      });
    }
  };

  return { transport, socket, hydrator, server, serve };
}

describe("open", () => {
  it("subscribes, completes the handshake, and yields the server's text", async () => {
    const { socket, hydrator, server, serve } = await fixture();
    server.get(DOC)!.text.insert(0, "# Groceries\n");

    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    const subscribe = socket.controlOfType("doc.subscribe");
    expect(subscribe).toHaveLength(1);
    expect(subscribe[0]?.id).toBe(DOC);
    // Nothing local yet, so no state vector is offered (PROTOCOL.md §3.3).
    expect(subscribe[0]?.sv).toBeUndefined();
    expect(handle.phase).toBe("live");
    expect(handle.text.toString()).toBe("# Groceries\n");
    expect(handle.doc.getText(TEXT_ROOT)).toBe(handle.text);
    expect(hydrator.openIds).toEqual([DOC]);
  });

  it("offers a state vector when a local replica exists", async () => {
    const persistence = new MemoryDocPersistence();
    const local = new Y.Doc();
    local.getText(TEXT_ROOT).insert(0, "offline draft");
    await persistence.save(DOC, Y.encodeStateAsUpdate(local));

    const { socket, hydrator, serve } = await fixture({ persistence, persistDebounceMs: 0 });
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    expect(socket.controlOfType("doc.subscribe")[0]?.sv).toBeTypeOf("string");
    expect(handle.text.toString()).toBe("offline draft");
  });

  it("returns the same replica to a second opener and unsubscribes only on the last release", async () => {
    const { socket, hydrator, serve } = await fixture();
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const first = await opening;
    const second = await hydrator.open(DOC);
    expect(second).toBe(first);

    first.release();
    expect(socket.controlOfType("doc.unsubscribe")).toHaveLength(0);
    second.release();
    expect(socket.controlOfType("doc.unsubscribe").map((m) => m.id)).toEqual([DOC]);
    // The replica stays in memory: reopening it is free, and it is still the
    // offline-editable copy.
    expect(hydrator.openIds).toEqual([DOC]);
  });

  it("shares one replica between concurrent openers, and one handshake", async () => {
    const { socket, hydrator, serve } = await fixture();

    const first = hydrator.open(DOC);
    const second = hydrator.open(DOC);
    await settle();
    serve();
    const [a, b] = await Promise.all([first, second]);

    expect(a).toBe(b);
    expect(socket.controlOfType("doc.subscribe")).toHaveLength(1);
    // Two references: the first release must not unsubscribe.
    a.release();
    expect(socket.controlOfType("doc.unsubscribe")).toHaveLength(0);
    b.release();
    expect(socket.controlOfType("doc.unsubscribe")).toHaveLength(1);
  });

  it("resolves from the local replica alone when there is no socket", async () => {
    const persistence = new MemoryDocPersistence();
    const local = new Y.Doc();
    local.getText(TEXT_ROOT).insert(0, "readable offline");
    await persistence.save(DOC, Y.encodeStateAsUpdate(local));

    MockSocket.reset();
    const { transport } = makeTransport(); // never connected
    const hydrator = new DocHydrator(transport, { persistence, syncTimeoutMs: 50 });

    const handle = await hydrator.open(DOC);

    expect(handle.text.toString()).toBe("readable offline");
    expect(MockSocket.instances).toHaveLength(0);
  });

  it("refuses to open a never-hydrated document with no socket", async () => {
    // SPEC §4.1, the sentence the test above is the other half of: "editable offline =
    // documents you've opened"; an unopened document is **read-only offline until
    // reconnect". There is no replica on disk here, so the `Y.Doc` this would hand back
    // is not the document — it is an empty one sharing its id.
    //
    // Returning it as `live` is worse than it sounds: the projection row is still full
    // of text, so the reader sees a populated read view, switches to edit, finds an
    // empty box, and is invited to type into a replica that is not the document. The
    // merge on reconnect is not lossy — Yjs keeps the insert — but it lands in a
    // document the user never saw. Refusing is what lets `document-surface` say
    // "editing is unavailable, reading works from the replicated copy".
    MockSocket.reset();
    const persistence = new MemoryDocPersistence();
    const { transport } = makeTransport(); // never connected
    const hydrator = new DocHydrator(transport, { persistence, syncTimeoutMs: 50 });

    const errors: DocError[] = [];
    const reporting = new DocHydrator(transport, {
      persistence,
      syncTimeoutMs: 50,
      onError: (_id, error) => errors.push(error),
    });

    await expect(hydrator.open(DOC)).rejects.toThrow(/cannot be hydrated while offline/);
    await expect(reporting.open(OTHER)).rejects.toThrow(/never opened/);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/not editable until reconnect/);

    // Nothing is left half-open: a later attempt (online) starts clean.
    await expect(hydrator.open(DOC)).rejects.toThrow(/cannot be hydrated while offline/);
    expect(MockSocket.instances).toHaveLength(0);
  });

  it("rejects, and forgets the replica, when the document is in the graveyard", async () => {
    const { socket, hydrator } = await fixture();
    const opening = hydrator.open(DOC);
    await settle();
    socket.deliver({
      t: "doc.error",
      id: DOC,
      code: "gone",
      message: "purged",
      retryable: false,
    });

    await expect(opening).rejects.toThrow(/gone/);
    expect(hydrator.openIds).toEqual([]);
  });
});

describe("editing", () => {
  it("sends local edits as UPDATE frames the server converges on", async () => {
    const { socket, hydrator, server, serve } = await fixture();
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    handle.text.insert(0, "hello ");
    handle.text.insert(6, "world");
    serve();

    expect(server.get(DOC)!.text.toString()).toBe("hello world");
    expect(socket.binaryOfType(FrameType.Update)).toHaveLength(0); // drained by serve()
    expect(hydrator.pendingCount).toBe(0);
  });

  it("applies remote updates without echoing them back", async () => {
    const { socket, hydrator, server, serve } = await fixture();
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    const remote = server.get(DOC)!;
    remote.text.insert(0, "from another editor");
    socket.deliverBinary({
      type: FrameType.Update,
      docId: DOC,
      payload: Y.encodeStateAsUpdate(remote.doc, Y.encodeStateVector(handle.doc)),
    });

    expect(handle.text.toString()).toBe("from another editor");
    expect(socket.sentBinary).toHaveLength(0);
  });

  it("queues edits made offline and reports them as pending", async () => {
    const persistence = new MemoryDocPersistence();
    const pendings: number[] = [];
    const { socket, hydrator, serve } = await fixture({
      persistence,
      persistDebounceMs: 0,
      onPending: (pending) => pendings.push(pending),
    });
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    socket.serverClose(1001, "network gone");
    hydrator.onDisconnected();
    handle.text.insert(0, "typed while offline");
    handle.text.insert(19, " and more");

    expect(hydrator.pendingCount).toBe(2);
    expect(pendings.at(-1)).toBe(2);
    // Durability does not depend on the in-memory queue: the replica is on disk.
    expect(persistence.states.has(DOC)).toBe(true);
  });

  it("flushes offline edits on reconnect, and the server converges", async () => {
    const persistence = new MemoryDocPersistence();
    const { socket, hydrator, transport, server, serve } = await fixture({
      persistence,
      persistDebounceMs: 0,
    });
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;
    handle.text.insert(0, "online text\n");
    serve();

    // Partition: socket dies, the user keeps typing.
    socket.serverClose(1001, "network gone");
    hydrator.onDisconnected();
    handle.text.insert(handle.text.length, "offline line\n");
    expect(hydrator.pendingCount).toBe(1);

    // Meanwhile the server has an edit of its own — a real reconnect has to merge.
    server.get(DOC)!.text.insert(server.get(DOC)!.text.length, "server line\n");

    const reconnected = await connect(transport);
    hydrator.resubscribeAll();
    // The re-subscribe carries the state vector, so the server's answer is a diff.
    expect(reconnected.controlOfType("doc.subscribe").at(-1)?.sv).toBeTypeOf("string");

    for (const frame of reconnected.sentBinary.splice(0)) {
      if (frame.type === FrameType.SyncStep1) {
        reconnected.deliverBinary(server.get(DOC)!.step2(frame.payload));
      } else {
        server.get(DOC)!.apply(frame);
      }
    }
    // The client answers the server's step 1 with everything it lacks.
    reconnected.deliverBinary(server.get(DOC)!.step1());
    for (const frame of reconnected.sentBinary.splice(0)) server.get(DOC)!.apply(frame);

    expect(server.get(DOC)!.text.toString()).toContain("offline line");
    expect(handle.text.toString()).toContain("server line");
    expect(server.get(DOC)!.text.toString()).toBe(handle.text.toString());
    expect(hydrator.pendingCount).toBe(0);
  });

  it("answers doc.resync with a fresh state vector", async () => {
    const { socket, hydrator, serve } = await fixture();
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    await opening;
    socket.sentBinary.splice(0);

    hydrator.onResync({ t: "doc.resync", reason: "backpressure", id: DOC });
    expect(socket.binaryOfType(FrameType.SyncStep1)).toHaveLength(1);

    socket.sentBinary.splice(0);
    // No id ⇒ every subscribed document (PROTOCOL.md §3.5).
    hydrator.onResync({ t: "doc.resync", reason: "server_restart" });
    expect(socket.binaryOfType(FrameType.SyncStep1)).toHaveLength(1);
  });
});

describe("awareness", () => {
  it("relays payloads in both directions, byte for byte", async () => {
    const { socket, hydrator, serve } = await fixture();
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    const received: Uint8Array[] = [];
    const stop = handle.onAwareness((payload) => received.push(payload));
    const payload = new Uint8Array([1, 0, 255, 42]);
    socket.deliverBinary({ type: FrameType.Awareness, docId: DOC, payload });
    expect(received).toHaveLength(1);
    expect([...(received[0] as Uint8Array)]).toEqual([1, 0, 255, 42]);

    handle.sendAwareness(new Uint8Array([7, 7]));
    const sent = socket.binaryOfType(FrameType.Awareness);
    expect([...(sent[0]?.payload as Uint8Array)]).toEqual([7, 7]);

    stop();
    socket.deliverBinary({ type: FrameType.Awareness, docId: DOC, payload });
    expect(received).toHaveLength(1);
  });

  it("drops awareness silently when the socket is gone (it is ephemeral)", async () => {
    const { socket, hydrator, serve } = await fixture();
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;
    socket.serverClose(1001, "gone");

    expect(() => handle.sendAwareness(new Uint8Array([1]))).not.toThrow();
  });
});

describe("the LRU", () => {
  async function openAndRelease(
    hydrator: DocHydrator,
    socket: MockSocket,
    serve: () => void,
    id: string,
  ): Promise<HydratedDoc> {
    const opening = hydrator.open(id);
    await settle();
    serve();
    const handle = await opening;
    handle.release();
    return handle;
  }

  it("evicts the oldest unreferenced replica past the budget", async () => {
    const persistence = new MemoryDocPersistence();
    const { socket, hydrator, server, serve } = await fixture(
      { lruSize: 2, persistence, persistDebounceMs: 0 },
      [DOC, OTHER, THIRD],
    );
    for (const doc of server.values()) doc.text.insert(0, `text of ${doc.id}\n`);

    await openAndRelease(hydrator, socket, serve, DOC);
    await openAndRelease(hydrator, socket, serve, OTHER);
    await openAndRelease(hydrator, socket, serve, THIRD);

    expect(hydrator.openIds).toEqual([OTHER, THIRD]);
    expect(hydrator.openIds).not.toContain(DOC);
    // Evicted from memory, not from disk: it is still editable offline.
    expect(persistence.states.has(DOC)).toBe(true);
  });

  it("keeps a document with a live handle, however old", async () => {
    const { socket, hydrator, serve } = await fixture({ lruSize: 1 }, [DOC, OTHER, THIRD]);
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    await opening; // held: never released

    await openAndRelease(hydrator, socket, serve, OTHER);
    await openAndRelease(hydrator, socket, serve, THIRD);

    expect(hydrator.openIds).toContain(DOC);
  });

  it("never evicts a document with queued offline edits", async () => {
    const { socket, hydrator, serve } = await fixture({ lruSize: 1 }, [DOC, OTHER]);
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    socket.serverClose(1001, "offline");
    hydrator.onDisconnected();
    handle.text.insert(0, "unsent");
    handle.release();

    // Opening a second document would normally evict the first one.
    await hydrator.open(OTHER).catch(() => undefined);

    expect(hydrator.openIds).toContain(DOC);
    expect(hydrator.pendingCount).toBe(1);
  });
});

describe("purge and recovery", () => {
  it("offers the text before discarding a replica with unsynced edits", async () => {
    const persistence = new MemoryDocPersistence();
    const discarded: Array<{ id: string; hadUnsyncedEdits: boolean; text: string }> = [];
    const { socket, hydrator, serve } = await fixture({
      persistence,
      persistDebounceMs: 0,
      onReplicaDiscarded: (info) => discarded.push(info),
    });
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    socket.serverClose(1001, "offline");
    hydrator.onDisconnected();
    handle.text.insert(0, "my unsynced version");

    await hydrator.dropReplicas([DOC]);

    expect(discarded).toEqual([
      { id: DOC, hadUnsyncedEdits: true, text: "my unsynced version" },
    ]);
    expect(hydrator.openIds).toEqual([]);
    expect(persistence.states.has(DOC)).toBe(false);
    expect(hydrator.pendingCount).toBe(0);
  });

  it("offers the text of a persisted replica that is not open", async () => {
    // The shape of the real loss: edits made offline are merged into the `docs`
    // blob, then the tab is reloaded — so the replica is on disk with no in-memory
    // handle when the purge row for that document finally arrives.
    const persistence = new MemoryDocPersistence();
    const offline = new Y.Doc();
    offline.getText(TEXT_ROOT).insert(0, "the only copy of my edit");
    await persistence.save(DOC, Y.encodeStateAsUpdate(offline), { unsynced: true });

    const discarded: Array<{ id: string; hadUnsyncedEdits: boolean; text: string }> = [];
    const { hydrator } = await fixture({
      persistence,
      persistDebounceMs: 0,
      onReplicaDiscarded: (info) => discarded.push(info),
    });

    await hydrator.dropReplicas([DOC]);

    expect(discarded).toEqual([
      { id: DOC, hadUnsyncedEdits: true, text: "the only copy of my edit" },
    ]);
    expect(persistence.states.has(DOC)).toBe(false);
  });

  it("reports a persisted replica of unknown state as unsynced", async () => {
    // A record written before the flag existed: the store cannot say, so the
    // hydrator offers recovery rather than deleting silently.
    const persistence = new MemoryDocPersistence();
    const stale = new Y.Doc();
    stale.getText(TEXT_ROOT).insert(0, "unknown provenance");
    persistence.states.set(DOC, {
      state: Y.encodeStateAsUpdate(stale),
      touchedAt: 1,
      unsynced: undefined as unknown as boolean,
    });

    const discarded: Array<{ id: string; hadUnsyncedEdits: boolean }> = [];
    const { hydrator } = await fixture({
      persistence,
      persistDebounceMs: 0,
      onReplicaDiscarded: ({ id, hadUnsyncedEdits }) => discarded.push({ id, hadUnsyncedEdits }),
    });

    await hydrator.dropReplicas([DOC]);

    expect(discarded).toEqual([{ id: DOC, hadUnsyncedEdits: true }]);
  });

  it("still reports a synced persisted replica, flagged as having no unsynced edits", async () => {
    const persistence = new MemoryDocPersistence();
    const cached = new Y.Doc();
    cached.getText(TEXT_ROOT).insert(0, "same as the server");
    await persistence.save(DOC, Y.encodeStateAsUpdate(cached), { unsynced: false });

    const discarded: Array<{ id: string; hadUnsyncedEdits: boolean }> = [];
    const { hydrator } = await fixture({
      persistence,
      persistDebounceMs: 0,
      onReplicaDiscarded: ({ id, hadUnsyncedEdits }) => discarded.push({ id, hadUnsyncedEdits }),
    });

    await hydrator.dropReplicas([DOC]);

    expect(discarded).toEqual([{ id: DOC, hadUnsyncedEdits: false }]);
    expect(persistence.states.has(DOC)).toBe(false);
  });

  it("flags the persisted replica while edits are queued, and clears it when they go", async () => {
    const persistence = new MemoryDocPersistence();
    const { socket, hydrator, serve } = await fixture({
      persistence,
      persistDebounceMs: 0,
    });
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    socket.serverClose(1001, "offline");
    hydrator.onDisconnected();
    handle.text.insert(0, "queued offline");
    await settle();

    expect(persistence.states.get(DOC)?.unsynced).toBe(true);
    // Pinned, so the LRU cannot take it however small the budget is.
    expect(await persistence.prune(0)).toEqual([]);
    expect(persistence.states.has(DOC)).toBe(true);
  });
});

describe("the oversize escape hatch", () => {
  it("hydrates over REST and re-subscribes with the resulting state vector", async () => {
    const heavy = new Y.Doc();
    heavy.getText(TEXT_ROOT).insert(0, "a document too large for one frame");
    const state = Y.encodeStateAsUpdate(heavy);
    const fetchImpl = vi.fn(
      async (url: string) => new Response(state as unknown as BodyInit, { status: 200, headers: { "x-url": url } }),
    );

    const errors: DocError[] = [];
    const { socket, hydrator } = await fixture({
      restBaseUrl: "http://127.0.0.1:8080/",
      bearerToken: "t0ken",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onError: (_id, error) => errors.push(error),
    });
    const opening = hydrator.open(DOC);
    await settle();
    socket.sentControl.splice(0);

    hydrator.onDocError({
      t: "doc.error",
      id: DOC,
      code: "too_large",
      message: "state exceeds max_frame_bytes",
      retryable: true,
      hint: "rest",
    });
    await settle();
    // Answer the re-subscribe so `open()` can settle.
    for (const frame of socket.sentBinary.splice(0)) {
      if (frame.type === FrameType.SyncStep1) {
        socket.deliverBinary({
          type: FrameType.SyncStep2,
          docId: DOC,
          payload: Y.encodeStateAsUpdate(heavy, frame.payload),
        });
      }
    }
    const handle = await opening;

    const url = fetchImpl.mock.calls[0]?.[0] ?? "";
    expect(url).toContain(`/api/documents/${DOC}`);
    expect(url).toContain("format=crdt");
    expect(handle.text.toString()).toBe("a document too large for one frame");
    expect(socket.controlOfType("doc.subscribe").at(-1)?.sv).toBeTypeOf("string");
    // The notice is still surfaced — the hydrator recovers, it does not hide.
    expect(errors.map((error) => error.code)).toEqual(["too_large"]);
  });

  it("does not hydrate over REST for a write refused as too large", async () => {
    // `too_large` with no `hint` is the *other* cause: the server refused a write
    // whose result would exceed MAX_DOCUMENT_BYTES (SPEC §3.5). Its state is
    // unchanged, so downloading the whole document proves nothing — and on a
    // document near the cap it is a megabyte of pointless traffic per keystroke
    // burst.
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array(), { status: 200 }));
    const errors: DocError[] = [];
    const { hydrator, serve } = await fixture({
      restBaseUrl: "http://127.0.0.1:8080/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onError: (_id, error) => errors.push(error),
    });
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    hydrator.onDocError({
      t: "doc.error",
      id: DOC,
      code: "too_large",
      message: "document text would be 1100000 bytes, limit is 1048576",
      retryable: false,
    });
    await settle();

    expect(fetchImpl).not.toHaveBeenCalled();
    // The UI can still tell what happened, and the document stays usable.
    expect(errors.map((error) => error.code)).toEqual(["too_large"]);
    expect(handle.phase).toBe("live");
  });
});

describe("robustness", () => {
  it("ignores frames for documents it does not hold, and unknown frame types", async () => {
    const { socket, hydrator, serve } = await fixture();
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;

    expect(() =>
      socket.deliverBinary({ type: FrameType.Update, docId: OTHER, payload: new Uint8Array([1]) }),
    ).not.toThrow();
    // 0x10 and up are reserved for M4 plugin channels: ignored, never fatal.
    expect(() =>
      socket.deliverBinary({ type: 0x11, docId: DOC, payload: new Uint8Array([1]) }),
    ).not.toThrow();
    expect(handle.phase).toBe("live");
  });

  it("reports a malformed update instead of poisoning the document", async () => {
    const errors: DocError[] = [];
    const { socket, hydrator, serve } = await fixture({
      onError: (_id, error) => errors.push(error),
    });
    const opening = hydrator.open(DOC);
    await settle();
    serve();
    const handle = await opening;
    handle.text.insert(0, "intact");

    socket.deliverBinary({
      type: FrameType.Update,
      docId: DOC,
      payload: new Uint8Array([255, 255, 255, 255]),
    });

    expect(errors.map((error) => error.code)).toEqual(["malformed_update"]);
    expect(handle.text.toString()).toBe("intact");
  });

  it("releaseAll persists and forgets everything", async () => {
    const persistence = new MemoryDocPersistence();
    const { hydrator, serve } = await fixture({ persistence, persistDebounceMs: 0 }, [DOC, OTHER]);
    for (const id of [DOC, OTHER]) {
      const opening = hydrator.open(id);
      await settle();
      serve();
      const handle = await opening;
      handle.text.insert(0, `text for ${id}`);
    }

    hydrator.releaseAll();

    expect(hydrator.openIds).toEqual([]);
    expect(hydrator.pendingCount).toBe(0);
    expect([...persistence.states.keys()].sort()).toEqual([DOC, OTHER].sort());
  });
});
