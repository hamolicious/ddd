/**
 * IndexedDB projection store (SPEC §4.1, PROTOCOL.md §2.4), against
 * `fake-indexeddb`.
 *
 * The invariants under test are the ones whose failure loses a document
 * silently: the watermark never outruns the rows, rows are last-writer-wins by
 * `seq`, a purge deletes, and `retainOnly` is the only garbage collector.
 */

import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  CHECKPOINT_KEY,
  IdbDocPersistence,
  IdbProjectionStore,
  ITERATE_CHUNK_ROWS,
  STORE_DOCS,
  STORE_META,
  STORE_PROJECTION,
} from "./idb-store.js";
import { EMPTY_CHECKPOINT, type StoreChange, type SyncCheckpoint } from "./projection-store.js";
import { feedRow } from "./testing.js";

let databases = 0;

function checkpoint(safeSeq: number, overrides: Partial<SyncCheckpoint> = {}): SyncCheckpoint {
  return { ...EMPTY_CHECKPOINT, safeSeq, updatedAt: 1, coreSemanticsVersion: 1, ...overrides };
}

/** ULID-shaped, lexicographically ordered ids. */
function id(n: number): string {
  return `01J8ZQ0M3M4YQV0X0PTN${String(n).padStart(6, "0")}`;
}

let store: IdbProjectionStore;

beforeEach(async () => {
  store = new IdbProjectionStore(`life-manager-test-${++databases}`);
  await store.open();
});

describe("applyRows", () => {
  it("writes rows and the checkpoint together", async () => {
    const applied = await store.applyRows(
      [feedRow({ id: id(1), seq: 10 }), feedRow({ id: id(2), seq: 11 })],
      checkpoint(11),
    );

    expect(applied.applied).toEqual([id(1), id(2)]);
    expect((await store.get(id(1)))?.seq).toBe(10);
    expect(await store.checkpoint()).toMatchObject({ safeSeq: 11, coreSemanticsVersion: 1 });
    // Same transaction, same database: the checkpoint is not a second write that
    // could be lost on its own.
    const raw = await store.db.get(STORE_META, CHECKPOINT_KEY);
    expect((raw?.value as SyncCheckpoint).safeSeq).toBe(11);
  });

  it("is last-writer-wins by seq, and idempotent", async () => {
    await store.applyRows([feedRow({ id: id(1), seq: 10, title: "first" })], checkpoint(10));

    const replay = await store.applyRows(
      [feedRow({ id: id(1), seq: 10, title: "replayed" })],
      checkpoint(10),
    );
    expect(replay.ignored).toEqual([id(1)]);
    expect((await store.get(id(1)))?.title).toBe("first");

    const stale = await store.applyRows(
      [feedRow({ id: id(1), seq: 9, title: "older" })],
      checkpoint(10),
    );
    expect(stale.ignored).toEqual([id(1)]);
    expect((await store.get(id(1)))?.title).toBe("first");

    const newer = await store.applyRows(
      [feedRow({ id: id(1), seq: 12, title: "newer" })],
      checkpoint(12),
    );
    expect(newer.applied).toEqual([id(1)]);
    expect((await store.get(id(1)))?.title).toBe("newer");
  });

  it("collapses repeats of one id inside a batch", async () => {
    const result = await store.applyRows(
      [
        feedRow({ id: id(1), seq: 5, title: "old" }),
        feedRow({ id: id(1), seq: 6, title: "new" }),
        feedRow({ id: id(1), seq: 4, title: "older" }),
      ],
      checkpoint(6),
    );
    expect(result.applied).toEqual([id(1), id(1)]);
    expect(result.ignored).toEqual([id(1)]);
    expect((await store.get(id(1)))?.title).toBe("new");
  });

  it("deletes on a purge row", async () => {
    await store.applyRows([feedRow({ id: id(1), seq: 1 })], checkpoint(1));
    const result = await store.applyRows(
      [
        feedRow({
          id: id(1),
          seq: 2,
          deleted: true,
          purged: true,
          deleted_at: "2026-09-24T10:00:00.000Z",
        }),
      ],
      checkpoint(2),
    );
    expect(result.purged).toEqual([id(1)]);
    expect(await store.get(id(1))).toBeUndefined();
  });

  it("keeps a tombstone readable (Trash works offline)", async () => {
    await store.applyRows(
      [feedRow({ id: id(1), seq: 3, deleted: true, deleted_at: "2026-09-24T10:00:00.000Z" })],
      checkpoint(3),
    );
    const row = await store.get(id(1));
    expect(row?.deleted).toBe(true);
    expect(await store.count()).toBe(0);
    expect(await store.count({ includeDeleted: true })).toBe(1);
  });

  it("never moves the watermark backwards", async () => {
    await store.applyRows([feedRow({ id: id(1), seq: 50 })], checkpoint(50));
    // `feed.resync { from_seq }` re-subscribes lower down; the rows that come back
    // must not rewind the resume point.
    await store.applyRows([feedRow({ id: id(2), seq: 51 })], checkpoint(20));
    expect((await store.checkpoint()).safeSeq).toBe(50);
  });

  it("advances the watermark on an empty batch", async () => {
    await store.applyRows([], checkpoint(99));
    expect((await store.checkpoint()).safeSeq).toBe(99);
  });

  it("notifies subscribers once per batch, after the commit", async () => {
    const changes: StoreChange[] = [];
    const seenInStore: Array<string | undefined> = [];
    store.subscribe((change) => {
      changes.push(change);
      seenInStore.push(change.applied[0]);
    });

    await store.applyRows(
      [feedRow({ id: id(1), seq: 1 }), feedRow({ id: id(2), seq: 2 })],
      checkpoint(2),
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ applied: [id(1), id(2)], purged: [], safeSeq: 2 });
    // The row is readable by the time the listener runs.
    expect(await store.get(seenInStore[0] as string)).toBeDefined();
  });

  /**
   * Two tabs, one IndexedDB, two feed sockets (SPEC §4.3 allows eight).
   *
   * The second tab to apply a batch correctly declines to write rows the first already
   * stored — and used to report nothing applied, so its live queries never re-ran. The
   * data sat in the shared database, visible to a fresh `query()`, while every open
   * list in that tab was frozen. A row committed by any tab is news to the readers in
   * all of them.
   */
  it("tells the other tabs about a batch, including one they declined to rewrite", async () => {
    const other = new IdbProjectionStore(store.name);
    await other.open();
    const heard: StoreChange[] = [];
    other.subscribe((change) => heard.push(change));

    await store.applyRows([feedRow({ id: id(1), seq: 7 })], checkpoint(7));
    // BroadcastChannel delivery is a task, not a microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ applied: [id(1)], safeSeq: 7 });
    // And the row really is readable from the other connection.
    expect((await other.get(id(1)))?.seq).toBe(7);

    // The second tab's own apply of the same batch is the no-op it should be: nothing
    // written, nothing announced a second time.
    const applied = await other.applyRows([feedRow({ id: id(1), seq: 7 })], checkpoint(7));
    expect(applied.applied).toEqual([]);
    expect(applied.ignored).toEqual([id(1)]);
    await other.close();
  });

  it("does not echo a broadcast back to the tab that sent it", async () => {
    const other = new IdbProjectionStore(store.name);
    await other.open();
    const mine: StoreChange[] = [];
    store.subscribe((change) => mine.push(change));

    await store.applyRows([feedRow({ id: id(2), seq: 3 })], checkpoint(3));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mine).toHaveLength(1);
    await other.close();
  });
});

describe("iteration", () => {
  it("walks every row across chunk boundaries, in key order", async () => {
    const total = ITERATE_CHUNK_ROWS * 2 + 3;
    const rows = Array.from({ length: total }, (_unused, index) =>
      feedRow({ id: id(index + 1), seq: index + 1 }),
    );
    await store.applyRows(rows, checkpoint(total));

    const seen: string[] = [];
    for await (const row of store.iterate()) seen.push(row.id);
    expect(seen).toHaveLength(total);
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(total);
    expect(await store.count()).toBe(total);
  });

  it("does not stall on a chunk that is entirely deleted rows", async () => {
    const deletedCount = ITERATE_CHUNK_ROWS + 2;
    const rows = [
      ...Array.from({ length: deletedCount }, (_unused, index) =>
        feedRow({
          id: id(index + 1),
          seq: index + 1,
          deleted: true,
          deleted_at: "2026-09-24T10:00:00.000Z",
        }),
      ),
      feedRow({ id: id(900), seq: 900 }),
    ];
    await store.applyRows(rows, checkpoint(900));

    const live: string[] = [];
    for await (const row of store.iterate()) live.push(row.id);
    expect(live).toEqual([id(900)]);

    const all: string[] = [];
    for await (const row of store.iterate({ includeDeleted: true })) all.push(row.id);
    expect(all).toHaveLength(deletedCount + 1);
  });

  it("getMany returns only what exists", async () => {
    await store.applyRows(
      [feedRow({ id: id(1), seq: 1 }), feedRow({ id: id(2), seq: 2 })],
      checkpoint(2),
    );
    const found = await store.getMany([id(2), id(1), id(3)]);
    expect(found.map((row) => row.id)).toEqual([id(2), id(1)]);
    expect(await store.getMany([])).toEqual([]);
  });
});

describe("retainOnly", () => {
  it("drops exactly the ids a complete bootstrap pass never mentioned", async () => {
    await store.applyRows(
      [
        feedRow({ id: id(1), seq: 1 }),
        feedRow({ id: id(2), seq: 2 }),
        feedRow({ id: id(3), seq: 3 }),
      ],
      checkpoint(3),
    );
    const changes: StoreChange[] = [];
    store.subscribe((change) => changes.push(change));

    const removed = await store.retainOnly(new Set([id(1), id(3)]));
    expect(removed).toEqual([id(2)]);
    expect(await store.get(id(2))).toBeUndefined();
    expect(await store.get(id(1))).toBeDefined();
    expect(changes).toHaveLength(1);
    expect(changes[0]?.purged).toEqual([id(2)]);
  });

  it("is silent when nothing needs dropping", async () => {
    await store.applyRows([feedRow({ id: id(1), seq: 1 })], checkpoint(1));
    const changes: StoreChange[] = [];
    store.subscribe((change) => changes.push(change));
    expect(await store.retainOnly(new Set([id(1)]))).toEqual([]);
    expect(changes).toHaveLength(0);
  });
});

describe("clear", () => {
  it("empties every store — the logout-only path", async () => {
    await store.applyRows([feedRow({ id: id(1), seq: 1 })], checkpoint(1));
    await new IdbDocPersistence(store).save(id(1), new Uint8Array([1, 2, 3]));

    await store.clear();

    expect(await store.db.count(STORE_PROJECTION)).toBe(0);
    expect(await store.checkpoint()).toEqual(EMPTY_CHECKPOINT);
    expect(await new IdbDocPersistence(store).load(id(1))).toBeUndefined();
  });
});

describe("IdbDocPersistence", () => {
  it("keeps another tab's unsent edits when this tab saves", async () => {
    const persistence = new IdbDocPersistence(store);
    // Both tabs start from the same document.
    const base = new Y.Doc();
    base.getText("content").insert(0, "base\n");
    const baseState = Y.encodeStateAsUpdate(base);

    // Another tab edits offline and saves, then is closed.
    const other = new Y.Doc();
    Y.applyUpdate(other, baseState);
    const before = Y.encodeStateVector(other);
    other.getText("content").insert(5, "from the other tab\n");
    const otherEdit = Y.encodeStateAsUpdate(other, before);
    await persistence.save(id(1), Y.encodeStateAsUpdate(other), {
      unsynced: true,
      journal: [{ origin: "another-tab", at: 1_000, lastAt: 1_000, update: otherEdit }],
    });

    // This tab, which never saw that edit, saves its own offline edit afterwards.
    const mine = new Y.Doc();
    Y.applyUpdate(mine, baseState);
    const mineBefore = Y.encodeStateVector(mine);
    mine.getText("content").insert(0, "mine\n");
    await persistence.save(id(1), Y.encodeStateAsUpdate(mine), {
      unsynced: true,
      journal: [{ at: 2_000, lastAt: 2_000, update: Y.encodeStateAsUpdate(mine, mineBefore) }],
    });

    const stored = await persistence.peek(id(1));
    const reopened = new Y.Doc();
    Y.applyUpdate(reopened, stored!.state);
    expect(reopened.getText("content").toString()).toContain("from the other tab");
    expect(reopened.getText("content").toString()).toContain("mine");
    expect(stored!.unsynced).toBe(true);
    expect(stored!.journal?.map((entry) => entry.at)).toEqual([1_000, 2_000]);
  });

  it("round-trips a replica and drops it", async () => {
    const persistence = new IdbDocPersistence(store);
    await persistence.save(id(1), new Uint8Array([9, 8, 7]));
    expect([...((await persistence.load(id(1))) ?? [])]).toEqual([9, 8, 7]);
    await persistence.drop(id(1));
    expect(await persistence.load(id(1))).toBeUndefined();
  });

  it("prunes the least recently touched replicas beyond the budget", async () => {
    const persistence = new IdbDocPersistence(store);
    for (let index = 1; index <= 5; index++) {
      await persistence.save(id(index), new Uint8Array([index]));
    }
    // Touch the oldest, so recency and insertion order disagree.
    await persistence.load(id(1));

    const evicted = await persistence.prune(2);
    expect(evicted).toHaveLength(3);
    expect(evicted).not.toContain(id(1));
    expect(evicted).not.toContain(id(5));
    // The projection rows are untouched: the document stays readable offline,
    // it is merely no longer editable offline.
    expect(await store.db.count(STORE_PROJECTION)).toBe(0);
  });

  it("never prunes a replica holding unsynced edits", async () => {
    const persistence = new IdbDocPersistence(store);
    // The oldest replica is the one with the offline edit, and then the user browses
    // four more documents — pure LRU would evict exactly the copy that matters.
    await persistence.save(id(1), new Uint8Array([1]), { unsynced: true });
    for (let index = 2; index <= 5; index++) {
      await persistence.save(id(index), new Uint8Array([index]));
    }

    const evicted = await persistence.prune(2);

    expect(evicted).not.toContain(id(1));
    expect(await persistence.peek(id(1))).toEqual({
      state: new Uint8Array([1]),
      unsynced: true,
    });
    // The budget still holds overall: one pinned replica plus one evictable one.
    expect(await store.db.count(STORE_DOCS)).toBe(2);

    // Once the edits are acknowledged the flag goes, and so may the replica.
    await persistence.save(id(1), new Uint8Array([1]), { unsynced: false });
    expect(await persistence.prune(0)).toContain(id(1));
  });

  it("peek reports a replica without disturbing its recency", async () => {
    const persistence = new IdbDocPersistence(store);
    await persistence.save(id(1), new Uint8Array([1]));
    await persistence.save(id(2), new Uint8Array([2]));

    // `load` would make id(1) the most recent; `peek` must not.
    expect(await persistence.peek(id(1))).toEqual({ state: new Uint8Array([1]), unsynced: false });
    expect(await persistence.prune(1)).toEqual([id(1)]);
    expect(await persistence.peek(id(1))).toBeUndefined();
  });
});
