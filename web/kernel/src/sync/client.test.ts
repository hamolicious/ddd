/**
 * `SyncClient`: the routing table, the reconnect loop, and the close codes
 * (PROTOCOL.md §§1.4, 7, 8; SPEC §5.3).
 *
 * The rule this file exists to protect is SPEC §5.3: **a 401 never clears local
 * data.** Everything else here is ordering and backoff bookkeeping.
 */

import { afterEach, describe, expect, it } from "vitest";

import { CloseCode, FrameType, type FeedBatch } from "../protocol.js";
import { SyncClient } from "./client.js";
import { MockSocket, ServerDoc, settle, welcome } from "./testing.js";
import { MemoryDocPersistence, MemoryProjectionStore, feedRow } from "../store/testing.js";
import type { FeedState } from "./feed-client.js";

const DOC = "01J8ZQ0M3M4YQV0X0PTN9R2G7C";
const ORIGIN = "http://127.0.0.1:8080";

const clients: SyncClient[] = [];

afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  MockSocket.reset();
});

/** Bootstrap that always answers "empty workspace, safe_seq 0". */
const emptyBootstrapFetch = (async () =>
  new Response(
    [
      JSON.stringify({
        type: "header",
        protocol: 1,
        safe_seq: 0,
        total: 0,
        limit: 200,
        cursor: null,
        core_semantics_version: 1,
      }),
      JSON.stringify({ type: "footer", count: 0, next_cursor: null, complete: true, safe_seq: 0 }),
    ].join("\n"),
  )) as unknown as typeof fetch;

interface Harness {
  client: SyncClient;
  store: MemoryProjectionStore;
  states: FeedState[];
  scheduled: Array<{ delay: number; run: () => void }>;
  socket: () => MockSocket;
}

function makeClient(
  options: {
    store?: MemoryProjectionStore;
    persistence?: MemoryDocPersistence;
    autoReconnect?: boolean;
    authProbe?: () => Promise<"ok" | "unauthenticated" | "unreachable">;
  } = {},
): Harness {
  MockSocket.reset();
  const store = options.store ?? new MemoryProjectionStore();
  const states: FeedState[] = [];
  const scheduled: Array<{ delay: number; run: () => void }> = [];
  const client = new SyncClient(store, {
    transport: {
      url: "ws://127.0.0.1:8080/api/sync",
      socketFactory: MockSocket.factory,
      bearerToken: "t0ken",
      heartbeatMs: 3_600_000,
    },
    bootstrap: { url: `${ORIGIN}/api/sync/bootstrap`, fetchImpl: emptyBootstrapFetch },
    hydrator: { syncTimeoutMs: 100, persistDebounceMs: 0, persistence: options.persistence },
    autoReconnect: options.autoReconnect ?? true,
    ...(options.authProbe ? { authProbe: options.authProbe } : {}),
    onState: (state) => states.push(state),
    setTimeoutImpl: (run, delay) => {
      scheduled.push({ delay, run });
      return undefined;
    },
  });
  clients.push(client);
  return { client, store, states, scheduled, socket: () => MockSocket.last };
}

/** Start the client and let the handshake complete. */
async function started(harness: Harness): Promise<MockSocket> {
  const starting = harness.client.start();
  MockSocket.last.open();
  await starting;
  MockSocket.last.deliver(welcome());
  await settle();
  return MockSocket.last;
}

function batch(overrides: Partial<FeedBatch> = {}): FeedBatch {
  return {
    t: "feed.batch",
    mode: "catchup",
    rows: [],
    safe_seq: 0,
    head_seq: 0,
    complete: true,
    ...overrides,
  };
}

describe("handshake", () => {
  it("offers the bearer subprotocol and subscribes after welcome", async () => {
    const harness = makeClient();
    const socket = await started(harness);

    expect(socket.protocols).toEqual(["life-manager.v1", "life-manager.bearer.t0ken"]);
    expect(socket.controlOfType("feed.subscribe")).toHaveLength(1);
    expect(harness.client.welcome?.protocol).toBe(1);
  });

  it("closes 4400 when anything arrives before welcome", async () => {
    const harness = makeClient();
    const starting = harness.client.start();
    MockSocket.last.open();
    await starting;

    MockSocket.last.deliver(batch());
    await settle();

    expect(MockSocket.last.closedWith?.code).toBe(CloseCode.ProtocolError);
  });

  it("closes 4409 on a protocol version it does not speak, and stops", async () => {
    const harness = makeClient();
    const starting = harness.client.start();
    const socket = MockSocket.last;
    socket.open();
    await starting;

    socket.deliver(welcome({ protocol: 99 }));
    await settle();

    expect(socket.closedWith?.code).toBe(CloseCode.UnsupportedVersion);
    // 4409 is terminal: only a reload (or an explicit reconnect) restarts it.
    expect(harness.scheduled).toHaveLength(0);
    expect(harness.client.status).toBe("error");
  });

  it("ignores control messages of unknown type (forward compatibility)", async () => {
    const harness = makeClient();
    const socket = await started(harness);

    socket.deliver({ t: "plugin.event", payload: { any: "thing" } });
    await settle();

    expect(socket.closedWith).toBeUndefined();
  });
});

describe("close codes", () => {
  it("4401 means re-authenticate: local data is untouched and the loop stops", async () => {
    const store = new MemoryProjectionStore();
    const harness = makeClient({ store });
    const socket = await started(harness);
    socket.deliver(batch({ rows: [feedRow({ id: "a", seq: 1 })], safe_seq: 1 }));
    await settle();
    expect(store.rows.has("a")).toBe(true);

    socket.serverClose(CloseCode.Unauthenticated, "session revoked");
    await settle();

    expect(harness.client.status).toBe("auth-required");
    expect(store.cleared).toBe(0);
    expect(store.rows.has("a")).toBe(true);
    expect((await store.checkpoint()).safeSeq).toBe(1);
    expect(harness.scheduled).toHaveLength(0);

    // A successful re-login restarts the loop without losing anything, even right after
    // another reconnect attempt (the throttle does not apply to signing back in).
    harness.client.reconnectNow();
    expect(MockSocket.instances).toHaveLength(2);
    MockSocket.last.serverClose(CloseCode.Unauthenticated, "still signed out");
    await settle();
    harness.client.reconnectNow();
    expect(MockSocket.instances).toHaveLength(3);
    expect(store.cleared).toBe(0);
  });

  it("a connection refused before it opens asks whether the session is still valid", async () => {
    // A refused upgrade (HTTP 401) reaches a browser as a plain failed connection.
    let verdict: "ok" | "unauthenticated" | "unreachable" = "unreachable";
    const harness = makeClient({ authProbe: () => Promise.resolve(verdict) });
    const socket = await started(harness);
    socket.serverClose(1006, "");
    await settle();
    harness.scheduled.splice(0).at(-1)?.run();
    await settle();

    // Offline: the probe cannot reach the server either, so keep trying.
    MockSocket.last.serverClose(1006, "");
    await settle();
    expect(harness.client.status).toBe("offline");
    expect(harness.scheduled).toHaveLength(1);

    // The session ended meanwhile: ask the person to sign in, and stop retrying.
    verdict = "unauthenticated";
    harness.scheduled.splice(0).at(-1)?.run();
    await settle();
    MockSocket.last.serverClose(1006, "");
    await settle();
    expect(harness.client.status).toBe("auth-required");
    expect(harness.scheduled).toHaveLength(0);
  });

  it("reconnects with backoff after an ordinary close", async () => {
    const harness = makeClient();
    const socket = await started(harness);

    socket.serverClose(1001, "going away");
    await settle();

    expect(harness.client.status).toBe("offline");
    expect(harness.scheduled).toHaveLength(1);
    expect(harness.scheduled[0]!.delay).toBeLessThanOrEqual(30_000);

    harness.scheduled[0]!.run();
    expect(MockSocket.instances).toHaveLength(2);
    MockSocket.last.open();
    await settle();
    MockSocket.last.deliver(welcome());
    await settle();
    expect(MockSocket.last.controlOfType("feed.subscribe")).toHaveLength(1);
  });

  it("uses the short deploy window for 4503", async () => {
    const harness = makeClient();
    const socket = await started(harness);

    socket.serverClose(CloseCode.ShuttingDown, "shutting down");
    await settle();

    expect(harness.scheduled).toHaveLength(1);
    // A deploy drops every socket at once: full jitter over a short window.
    expect(harness.scheduled[0]!.delay).toBeLessThanOrEqual(5_000);
  });

  it("stops after repeated 4400s — that is version skew, not bad luck", async () => {
    const harness = makeClient();
    let socket = await started(harness);

    for (let attempt = 0; attempt <= 2; attempt++) {
      socket.serverClose(CloseCode.ProtocolError, "bad frame");
      await settle();
      const pending = harness.scheduled.pop();
      if (!pending) break;
      pending.run();
      socket = MockSocket.last;
      socket.open();
      await settle();
      socket.deliver(welcome());
      await settle();
    }

    expect(harness.client.status).toBe("error");
    expect(harness.client.state.lastError).toMatch(/reload/);
    expect(harness.scheduled).toHaveLength(0);
  });

  it("does not reconnect at all when autoReconnect is off", async () => {
    const harness = makeClient({ autoReconnect: false });
    const socket = await started(harness);
    socket.serverClose(1006, "dropped");
    await settle();
    expect(harness.scheduled).toHaveLength(0);
  });

  it("stop() ends the loop and leaves local data alone", async () => {
    const store = new MemoryProjectionStore();
    const harness = makeClient({ store });
    const socket = await started(harness);
    socket.deliver(batch({ rows: [feedRow({ id: "a", seq: 1 })], safe_seq: 1 }));
    await settle();

    harness.client.stop();
    await settle();

    expect(harness.scheduled).toHaveLength(0);
    expect(store.cleared).toBe(0);
    expect(store.rows.has("a")).toBe(true);
    expect(harness.client.internals.stopped).toBe(true);
  });
});

describe("routing", () => {
  it("applies feed batches in arrival order even though applying awaits IndexedDB", async () => {
    const harness = makeClient();
    const socket = await started(harness);

    // Both frames land in the same tick: the queue is what keeps `seq` order.
    socket.deliver(batch({ rows: [feedRow({ id: "a", seq: 1 })], safe_seq: 1, complete: false }));
    socket.deliver(batch({ rows: [feedRow({ id: "b", seq: 2 })], safe_seq: 2, complete: false }));
    socket.deliver(batch({ safe_seq: 3, complete: true }));
    await settle();

    const seqs = harness.store.batches.flatMap((applied) => applied.rows.map((row) => row.seq));
    expect(seqs).toEqual([1, 2]);
    expect((await harness.store.checkpoint()).safeSeq).toBe(3);
    expect(harness.client.status).toBe("synced");
  });

  it("routes binary frames to the hydrator without queueing them", async () => {
    const harness = makeClient();
    const socket = await started(harness);
    const server = new ServerDoc(DOC);
    server.text.insert(0, "hydrated");

    const opening = harness.client.open(DOC);
    await settle();
    for (const frame of socket.sentBinary.splice(0)) {
      if (frame.type === FrameType.SyncStep1) socket.deliverBinary(server.step2(frame.payload));
    }
    const handle = await opening;

    expect(handle.text.toString()).toBe("hydrated");
    expect(harness.client.docs.openIds).toEqual([DOC]);
  });

  it("drops the local replica of a purged document, offering recovery first", async () => {
    const persistence = new MemoryDocPersistence();
    const discarded: Array<{ id: string; hadUnsyncedEdits: boolean; text: string }> = [];
    MockSocket.reset();
    const store = new MemoryProjectionStore();
    const client = new SyncClient(store, {
      transport: {
        url: "ws://127.0.0.1:8080/api/sync",
        socketFactory: MockSocket.factory,
        heartbeatMs: 3_600_000,
      },
      bootstrap: { url: `${ORIGIN}/api/sync/bootstrap`, fetchImpl: emptyBootstrapFetch },
      hydrator: {
        syncTimeoutMs: 100,
        persistDebounceMs: 0,
        persistence,
        onReplicaDiscarded: (info) => discarded.push(info),
      },
      autoReconnect: false,
    });
    clients.push(client);

    const starting = client.start();
    MockSocket.last.open();
    await starting;
    const socket = MockSocket.last;
    socket.deliver(welcome());
    await settle();

    const server = new ServerDoc(DOC);
    server.text.insert(0, "doomed");
    const opening = client.open(DOC);
    await settle();
    for (const frame of socket.sentBinary.splice(0)) {
      if (frame.type === FrameType.SyncStep1) socket.deliverBinary(server.step2(frame.payload));
    }
    await opening;
    expect(persistence.states.has(DOC)).toBe(true);

    socket.deliver(
      batch({
        mode: "live",
        rows: [feedRow({ id: DOC, seq: 9, deleted: true, purged: true })],
        safe_seq: 9,
        complete: false,
      }),
    );
    await settle();

    expect(store.rows.has(DOC)).toBe(false);
    expect(discarded.map((info) => info.id)).toEqual([DOC]);
    expect(discarded[0]?.text).toBe("doomed");
    expect(client.docs.openIds).toEqual([]);
    expect(persistence.states.has(DOC)).toBe(false);
  });

  it("re-subscribes open documents on the new connection", async () => {
    const harness = makeClient();
    const socket = await started(harness);
    const server = new ServerDoc(DOC);
    const opening = harness.client.open(DOC);
    await settle();
    for (const frame of socket.sentBinary.splice(0)) {
      if (frame.type === FrameType.SyncStep1) socket.deliverBinary(server.step2(frame.payload));
    }
    await opening;

    socket.serverClose(1001, "network");
    await settle();
    harness.scheduled[0]!.run();
    const reconnected = MockSocket.last;
    reconnected.open();
    await settle();
    reconnected.deliver(welcome());
    await settle();

    expect(reconnected.controlOfType("doc.subscribe").map((message) => message.id)).toEqual([DOC]);
  });
});

describe("status", () => {
  it("publishes the pending count alongside the status", async () => {
    const persistence = new MemoryDocPersistence();
    const harness = makeClient({ persistence });
    const socket = await started(harness);
    const server = new ServerDoc(DOC);
    const opening = harness.client.open(DOC);
    await settle();
    for (const frame of socket.sentBinary.splice(0)) {
      if (frame.type === FrameType.SyncStep1) socket.deliverBinary(server.step2(frame.payload));
    }
    const handle = await opening;

    socket.serverClose(1001, "offline now");
    await settle();
    handle.text.insert(0, "typed while offline");

    expect(harness.client.pending).toBe(1);
    expect(harness.client.state.pending).toBe(1);
    expect(harness.client.state.status).toBe("offline");
    expect(harness.states.at(-1)?.pending).toBe(1);
  });

  it("walks offline → connecting → syncing → synced", async () => {
    const harness = makeClient();
    const socket = await started(harness);
    socket.deliver(batch({ safe_seq: 0, complete: true }));
    await settle();

    const seen = harness.states.map((state) => state.status);
    expect(seen[0]).toBe("connecting");
    expect(seen).toContain("syncing");
    expect(seen.at(-1)).toBe("synced");
  });
});
