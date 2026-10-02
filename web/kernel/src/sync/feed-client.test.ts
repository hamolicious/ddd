import { afterEach, describe, expect, it, vi } from "vitest";

import { BootstrapClient } from "./bootstrap.js";
import { FeedClient, type FeedState } from "./feed-client.js";
import { SyncTransport } from "./transport.js";
import { MockSocket, welcome } from "./testing.js";
import { MemoryProjectionStore, feedRow } from "../store/testing.js";
import type { FeedBatch, FeedRow, Welcome } from "../protocol.js";

const ORIGIN = "http://127.0.0.1:8080";

const transports: SyncTransport[] = [];

afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
  MockSocket.reset();
});

async function connected(): Promise<{ transport: SyncTransport; socket: MockSocket }> {
  MockSocket.reset();
  const transport = new SyncTransport({
    url: "ws://127.0.0.1:8080/api/sync",
    socketFactory: MockSocket.factory,
    heartbeatMs: 3_600_000,
  });
  transports.push(transport);
  const opening = transport.connect();
  MockSocket.last.open();
  await opening;
  return { transport, socket: MockSocket.last };
}

function bootstrapWith(
  store: MemoryProjectionStore,
  rows: FeedRow[],
  safeSeq: number,
): { bootstrap: BootstrapClient; calls: number } {
  const state = { calls: 0 };
  const impl = (async () => {
    state.calls++;
    const lines = [
      JSON.stringify({
        type: "header",
        protocol: 1,
        safe_seq: safeSeq,
        total: rows.length,
        limit: 200,
        cursor: null,
        core_semantics_version: 1,
      }),
      ...rows.map((row) => JSON.stringify({ type: "row", ...row })),
      JSON.stringify({
        type: "footer",
        count: rows.length,
        next_cursor: null,
        complete: true,
        safe_seq: safeSeq,
      }),
    ];
    return new Response(lines.join("\n") + "\n");
  }) as unknown as typeof fetch;
  return {
    bootstrap: new BootstrapClient(store, {
      url: `${ORIGIN}/api/sync/bootstrap`,
      fetchImpl: impl,
    }),
    get calls() {
      return state.calls;
    },
  };
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

function bootstrappedCheckpoint(store: MemoryProjectionStore, safeSeq: number): Promise<void> {
  return store.setCheckpoint({
    safeSeq,
    updatedAt: 1,
    coreSemanticsVersion: 1,
    bootstrapped: true,
  });
}

describe("start", () => {
  it("bootstraps when the store is empty, then tails from the pinned safe_seq", async () => {
    const store = new MemoryProjectionStore();
    const { transport, socket } = await connected();
    const seeded = [feedRow({ id: "a", seq: 5 }), feedRow({ id: "b", seq: 6 })];
    const wiring = bootstrapWith(store, seeded, 6);
    const states: FeedState[] = [];
    const feed = new FeedClient(transport, store, wiring.bootstrap, {
      onState: (state) => states.push(state),
    });

    await feed.start(welcome({ feed: { head_seq: 6, safe_seq: 6, floor_seq: 0 } }));

    expect(wiring.calls).toBe(1);
    expect(store.rows.size).toBe(2);
    expect(socket.controlOfType("feed.subscribe")).toEqual([
      { t: "feed.subscribe", since_seq: 6, include_content: true, batch_max_rows: 200 },
    ]);
    expect(states.map((state) => state.status)).toContain("syncing");
    expect(states.some((state) => state.bootstrap !== undefined)).toBe(true);
  });

  it("tails from the stored watermark when a bootstrap already happened", async () => {
    const store = new MemoryProjectionStore();
    await bootstrappedCheckpoint(store, 48_150);
    const { transport, socket } = await connected();
    const wiring = bootstrapWith(store, [], 0);
    const feed = new FeedClient(transport, store, wiring.bootstrap);

    await feed.start(welcome({ feed: { head_seq: 48_213, safe_seq: 48_213, floor_seq: 0 } }));

    expect(wiring.calls).toBe(0);
    expect(socket.controlOfType("feed.subscribe")[0]?.since_seq).toBe(48_150);
    expect(feed.state.headSeq).toBe(48_213);
  });

  it("bootstraps when the feed floor has moved past the watermark", async () => {
    const store = new MemoryProjectionStore();
    await bootstrappedCheckpoint(store, 10);
    const { transport } = await connected();
    const wiring = bootstrapWith(store, [feedRow({ id: "a", seq: 900 })], 900);
    const feed = new FeedClient(transport, store, wiring.bootstrap);

    await feed.start(welcome({ feed: { head_seq: 900, safe_seq: 900, floor_seq: 500 } }));

    expect(wiring.calls).toBe(1);
    expect((await store.checkpoint()).safeSeq).toBe(900);
  });

  it("reports auth-required when bootstrap is refused, keeping local data", async () => {
    const store = new MemoryProjectionStore();
    await store.applyRows([feedRow({ id: "a", seq: 1 })], {
      safeSeq: 0,
      updatedAt: 0,
      coreSemanticsVersion: 1,
      bootstrapped: false,
    });
    const { transport } = await connected();
    const bootstrap = new BootstrapClient(store, {
      url: `${ORIGIN}/api/sync/bootstrap`,
      fetchImpl: (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch,
    });
    const feed = new FeedClient(transport, store, bootstrap);

    await feed.start(welcome());

    expect(feed.state.status).toBe("auth-required");
    expect(store.cleared).toBe(0);
    expect(store.rows.has("a")).toBe(true);
  });
});

describe("onBatch", () => {
  it("persists the server's safe_seq, never max(seq) of the rows", async () => {
    const store = new MemoryProjectionStore();
    await bootstrappedCheckpoint(store, 40);
    const { transport } = await connected();
    const feed = new FeedClient(transport, store, bootstrapWith(store, [], 0).bootstrap);
    await feed.start(welcome({ feed: { head_seq: 61, safe_seq: 55, floor_seq: 0 } }));

    await feed.onBatch(
      batch({
        rows: [feedRow({ id: "a", seq: 60 }), feedRow({ id: "b", seq: 61 })],
        safe_seq: 55,
        head_seq: 61,
        complete: false,
      }),
    );

    expect((await store.checkpoint()).safeSeq).toBe(55);
    expect(feed.state.safeSeq).toBe(55);
    expect(store.rows.get("b")?.seq).toBe(61);
  });

  it("flips to synced on the completing catch-up batch and stays there live", async () => {
    const store = new MemoryProjectionStore();
    await bootstrappedCheckpoint(store, 1);
    const { transport } = await connected();
    const feed = new FeedClient(transport, store, bootstrapWith(store, [], 0).bootstrap);
    await feed.start(welcome());
    expect(feed.state.status).toBe("syncing");

    await feed.onBatch(batch({ rows: [feedRow({ id: "a", seq: 2 })], safe_seq: 2, complete: false }));
    expect(feed.state.status).toBe("syncing");
    expect(feed.caughtUp).toBe(false);

    await feed.onBatch(batch({ safe_seq: 2, complete: true }));
    expect(feed.state.status).toBe("synced");
    expect(feed.caughtUp).toBe(true);

    await feed.onBatch(batch({ mode: "live", rows: [feedRow({ id: "b", seq: 3 })], safe_seq: 3, complete: false }));
    expect(feed.state.status).toBe("synced");
  });

  it("records a completed pass from seq 0 as a bootstrap", async () => {
    const store = new MemoryProjectionStore();
    const { transport } = await connected();
    const feed = new FeedClient(transport, store, bootstrapWith(store, [], 0).bootstrap);
    feed.subscribe(0);

    await feed.onBatch(batch({ rows: [feedRow({ id: "a", seq: 1 })], safe_seq: 1, complete: true }));

    expect(await store.checkpoint()).toMatchObject({ safeSeq: 1, bootstrapped: true });
  });

  it("drops the local row for a purged document", async () => {
    const store = new MemoryProjectionStore();
    await bootstrappedCheckpoint(store, 1);
    const { transport } = await connected();
    const feed = new FeedClient(transport, store, bootstrapWith(store, [], 0).bootstrap);
    await feed.onBatch(batch({ rows: [feedRow({ id: "a", seq: 2 })], safe_seq: 2 }));
    expect(store.rows.has("a")).toBe(true);

    await feed.onBatch(
      batch({
        rows: [feedRow({ id: "a", seq: 3, deleted: true, purged: true })],
        safe_seq: 3,
      }),
    );
    expect(store.rows.has("a")).toBe(false);
  });
});

describe("recovery", () => {
  it("feed.reset bootstraps without clearing the store first", async () => {
    const store = new MemoryProjectionStore();
    await bootstrappedCheckpoint(store, 10);
    await store.applyRows([feedRow({ id: "keep", seq: 10 })], {
      safeSeq: 10,
      updatedAt: 0,
      coreSemanticsVersion: 1,
      bootstrapped: true,
    });
    const { transport, socket } = await connected();
    const wiring = bootstrapWith(store, [feedRow({ id: "keep", seq: 11 }), feedRow({ id: "new", seq: 12 })], 12);
    const feed = new FeedClient(transport, store, wiring.bootstrap);

    await feed.onReset({ t: "feed.reset", reason: "bootstrap_required", floor_seq: 0, head_seq: 12, pending_rows: 5000 });

    expect(store.cleared).toBe(0);
    expect(wiring.calls).toBe(1);
    expect([...store.rows.keys()].sort()).toEqual(["keep", "new"]);
    expect(socket.controlOfType("feed.subscribe").at(-1)?.since_seq).toBe(12);
  });

  it("stops bootstrapping in circles when the pass keeps failing", async () => {
    const store = new MemoryProjectionStore();
    const { transport } = await connected();
    let calls = 0;
    const bootstrap = new BootstrapClient(store, {
      url: `${ORIGIN}/api/sync/bootstrap`,
      fetchImpl: (async () => {
        calls++;
        return new Response("boom", { status: 500 });
      }) as unknown as typeof fetch,
    });
    const feed = new FeedClient(transport, store, bootstrap);

    const reset = {
      t: "feed.reset" as const,
      reason: "bootstrap_required" as const,
      floor_seq: 0,
      head_seq: 1,
    };
    for (let attempt = 0; attempt < 6; attempt++) await feed.onReset(reset);

    expect(calls).toBe(3);
    expect(feed.state.status).toBe("error");
  });

  it("feed.resync re-subscribes at from_seq and keeps every row", async () => {
    const store = new MemoryProjectionStore();
    await bootstrappedCheckpoint(store, 200);
    await store.applyRows([feedRow({ id: "a", seq: 200 })], {
      safeSeq: 200,
      updatedAt: 0,
      coreSemanticsVersion: 1,
      bootstrapped: true,
    });
    const { transport, socket } = await connected();
    const feed = new FeedClient(transport, store, bootstrapWith(store, [], 0).bootstrap);

    feed.onResync({ t: "feed.resync", reason: "backpressure", from_seq: 150 });

    expect(socket.controlOfType("feed.subscribe").at(-1)?.since_seq).toBe(150);
    expect(store.cleared).toBe(0);
    expect(store.rows.has("a")).toBe(true);
    expect((await store.checkpoint()).safeSeq).toBe(200);
  });

  it("goes offline, not error, when the socket dies mid-bootstrap", async () => {
    const store = new MemoryProjectionStore();
    const { transport, socket } = await connected();
    const bootstrap = new BootstrapClient(store, {
      url: `${ORIGIN}/api/sync/bootstrap`,
      fetchImpl: (async () => {
        socket.serverClose(1001, "going away");
        return new Response(
          [
            JSON.stringify({
              type: "header",
              protocol: 1,
              safe_seq: 7,
              total: 0,
              limit: 200,
              cursor: null,
              core_semantics_version: 1,
            }),
            JSON.stringify({ type: "footer", count: 0, next_cursor: null, complete: true, safe_seq: 7 }),
          ].join("\n"),
        );
      }) as unknown as typeof fetch,
    });
    const feed = new FeedClient(transport, store, bootstrap);

    await feed.start(welcome());

    expect(feed.state.status).toBe("offline");
    expect(await store.checkpoint()).toMatchObject({ safeSeq: 7, bootstrapped: true });
  });
});

describe("state", () => {
  it("reports the sync statuses of SPEC §6.4", async () => {
    const store = new MemoryProjectionStore();
    const { transport } = await connected();
    const seen: string[] = [];
    const feed = new FeedClient(transport, store, bootstrapWith(store, [], 0).bootstrap, {
      onState: (state) => seen.push(state.status),
    });

    expect(feed.state.status).toBe("offline");
    feed.onConnecting();
    await bootstrappedCheckpoint(store, 1);
    await feed.start(welcome());
    await feed.onBatch(batch({ safe_seq: 1, complete: true }));
    feed.onDisconnected("auth-required");

    expect(seen).toEqual(["connecting", "syncing", "synced", "auth-required"]);
  });

  it("passes include_content through to the subscription", async () => {
    const store = new MemoryProjectionStore();
    const { transport, socket } = await connected();
    const feed = new FeedClient(transport, store, bootstrapWith(store, [], 0).bootstrap, {
      includeContent: false,
      batchMaxRows: 25,
    });
    feed.subscribe(3);
    expect(socket.controlOfType("feed.subscribe")[0]).toEqual({
      t: "feed.subscribe",
      since_seq: 3,
      include_content: false,
      batch_max_rows: 25,
    });
    feed.unsubscribe();
    expect(socket.sentControl.at(-1)).toEqual({ t: "feed.unsubscribe" });
  });
});

describe("the store is the only writer", () => {
  it("hands rows and checkpoint to applyRows in one call per batch", async () => {
    const store = new MemoryProjectionStore();
    await bootstrappedCheckpoint(store, 1);
    const { transport } = await connected();
    const feed = new FeedClient(transport, store, bootstrapWith(store, [], 0).bootstrap);
    await feed.start(welcome({ core_semantics_version: 4 }));
    const spy = vi.spyOn(store, "applyRows");

    await feed.onBatch(batch({ rows: [feedRow({ id: "a", seq: 2 })], safe_seq: 2 }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ safeSeq: 2, coreSemanticsVersion: 4 });
  });
});

const _typecheck: Welcome = welcome();
void _typecheck;
