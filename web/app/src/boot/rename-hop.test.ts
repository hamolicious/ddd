/** RENAME-HOP: the pre-rename storage migration, against `fake-indexeddb`. Deleted with it. */

import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";

import { BATCH, migrateLegacyStorage, renamedDatabase, renamedKey } from "./rename-hop.js";

function memoryStorage(entries: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function openDb(idb: IDBFactory, name: string, version: number, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = idb.open(name, version);
    r.onupgradeneeded = () => upgrade(r.result);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function put(db: IDBDatabase, store: string, values: readonly unknown[], keys?: readonly IDBValidKey[]): Promise<void> {
  const tx = db.transaction(store, "readwrite");
  values.forEach((value, i) => (keys ? tx.objectStore(store).put(value, keys[i]) : tx.objectStore(store).put(value)));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

const names = async (idb: IDBFactory): Promise<string[]> => (await idb.databases()).map((db) => db.name!).sort();

/** A pre-rename replica: in-line keys with an index, out-of-line keys, more than one batch. */
async function legacyReplica(idb: IDBFactory, rows = BATCH * 2 + 7): Promise<void> {
  const db = await openDb(idb, "life-manager", 4, (d) => {
    const docs = d.createObjectStore("docs", { keyPath: "id" });
    docs.createIndex("by_parent", "parent", { unique: false });
    docs.createIndex("by_tags", "tags", { unique: false, multiEntry: true });
    d.createObjectStore("meta");
    d.createObjectStore("log", { autoIncrement: true });
  });
  await put(
    db,
    "docs",
    Array.from({ length: rows }, (_, i) => ({ id: `d${String(i).padStart(5, "0")}`, parent: i % 3, tags: ["a", `t${i}`] })),
  );
  await put(db, "meta", [{ safeSeq: 42 }, "x"], ["checkpoint", ["compound", 1]]);
  await put(db, "log", ["one", "two"]);
  db.close();
}

describe("rename hop: legacy storage", () => {
  it("maps the old names", () => {
    expect(renamedDatabase("life-manager")).toBe("ddd");
    expect(renamedDatabase("life-manager:attachments")).toBe("ddd:attachments");
    expect(renamedDatabase("life-manager-search")).toBeUndefined();
    expect(renamedDatabase("ddd")).toBeUndefined();
    expect(renamedKey("life-manager.boot.session")).toBe("ddd.boot.session");
    expect(renamedKey("life-manager:storage-asked")).toBe("ddd:storage-asked");
    expect(renamedKey("lm.shell.sidebar-width")).toBe("ddd.shell.sidebar-width");
    expect(renamedKey("lm:sw-auto-applied-at")).toBe("ddd:sw-auto-applied-at");
    expect(renamedKey("ddd.color-scheme")).toBeUndefined();
  });

  it("renames localStorage keys, never overwriting a new one", async () => {
    const storage = memoryStorage({
      "life-manager.boot.session": "old-session",
      "life-manager.color-scheme": "dark",
      "lm.shell.sidebar-width": "300",
      "life-manager:storage-asked": "1",
      "ddd.color-scheme": "light",
      unrelated: "kept",
    });
    await migrateLegacyStorage({ localStorage: storage });
    const all = Object.fromEntries(Array.from({ length: storage.length }, (_, i) => [storage.key(i)!, storage.getItem(storage.key(i)!)]));
    expect(all).toEqual({
      "ddd.boot.session": "old-session",
      "ddd.color-scheme": "light",
      "ddd.shell.sidebar-width": "300",
      "ddd:storage-asked": "1",
      unrelated: "kept",
    });
  });

  it("deletes the old caches only", async () => {
    const keys = ["life-manager:api", "lm-shell", "lm-plugins", "lm-runtime", "lm-meta", "ddd-shell", "workbox-precache-v2"];
    const caches = { keys: vi.fn(async () => keys), delete: vi.fn(async (_key: string) => true) };
    await migrateLegacyStorage({ caches });
    expect(caches.delete.mock.calls.map(([key]) => key).sort()).toEqual(["life-manager:api", "lm-meta", "lm-plugins", "lm-runtime", "lm-shell"]);
  });

  it("copies the replica to the new name with its schema, keys and records, then deletes the old one", async () => {
    const idb = new IDBFactory();
    await legacyReplica(idb);
    const progress = vi.fn();
    await migrateLegacyStorage({ indexedDB: idb, localStorage: memoryStorage(), onProgress: progress });
    expect(await names(idb)).toEqual(["ddd"]);

    const db = await openDb(idb, "ddd", 4, () => {
      throw new Error("must already be at version 4");
    });
    expect([...db.objectStoreNames].sort()).toEqual(["docs", "log", "meta"]);
    const tx = db.transaction(["docs", "meta", "log"], "readonly");
    const docs = tx.objectStore("docs");
    expect(docs.keyPath).toBe("id");
    expect(docs.index("by_tags").multiEntry).toBe(true);
    expect(await request(docs.count())).toBe(BATCH * 2 + 7);
    expect(await request(docs.index("by_parent").count(IDBKeyRange.only(0)))).toBe(Math.ceil((BATCH * 2 + 7) / 3));
    expect(await request(docs.index("by_tags").count(IDBKeyRange.only("t7")))).toBe(1);
    expect(await request(tx.objectStore("meta").get("checkpoint"))).toEqual({ safeSeq: 42 });
    expect(await request(tx.objectStore("meta").get(["compound", 1]))).toBe("x");
    expect(tx.objectStore("log").autoIncrement).toBe(true);
    expect(await request(tx.objectStore("log").getAllKeys())).toEqual([1, 2]);
    db.close();
    expect(progress).toHaveBeenLastCalledWith(BATCH * 2 + 7 + 4, BATCH * 2 + 7 + 4);
  });

  it("renames plugin databases, deletes the old search index, leaves others alone", async () => {
    const idb = new IDBFactory();
    const queue = await openDb(idb, "life-manager:attachments", 1, (d) => d.createObjectStore("waiting", { keyPath: "token" }));
    await put(queue, "waiting", [{ token: "t1", blob: "bytes" }]);
    queue.close();
    (await openDb(idb, "life-manager-search", 3, (d) => d.createObjectStore("chunks"))).close();
    (await openDb(idb, "someone-else", 1, () => undefined)).close();
    await migrateLegacyStorage({ indexedDB: idb, localStorage: memoryStorage() });
    expect(await names(idb)).toEqual(["ddd:attachments", "someone-else"]);
    const db = await openDb(idb, "ddd:attachments", 1, () => undefined);
    expect(await request(db.transaction("waiting").objectStore("waiting").get("t1"))).toEqual({ token: "t1", blob: "bytes" });
    db.close();
  });

  it("leaves the old database alone when the new one already exists", async () => {
    const idb = new IDBFactory();
    await legacyReplica(idb, 3);
    (await openDb(idb, "ddd", 4, (d) => d.createObjectStore("docs", { keyPath: "id" }))).close();
    await migrateLegacyStorage({ indexedDB: idb, localStorage: memoryStorage() });
    expect(await names(idb)).toEqual(["ddd", "life-manager"]);
  });

  it("starts again when a copy was cut short", async () => {
    const idb = new IDBFactory();
    await legacyReplica(idb, 3);
    (await openDb(idb, "ddd", 4, (d) => d.createObjectStore("half"))).close();
    const storage = memoryStorage({ "ddd.rename-hop.copying:ddd": "1" });
    await migrateLegacyStorage({ indexedDB: idb, localStorage: storage });
    expect(await names(idb)).toEqual(["ddd"]);
    const db = await openDb(idb, "ddd", 4, () => undefined);
    expect([...db.objectStoreNames].sort()).toEqual(["docs", "log", "meta"]);
    db.close();
    expect(storage.getItem("ddd.rename-hop.copying:ddd")).toBeNull();
  });

  it("never throws", async () => {
    const warn = vi.fn();
    const broken = {
      get length(): number {
        throw new Error("no storage");
      },
    } as unknown as Storage;
    const idb = { databases: () => Promise.reject(new Error("no listing")) } as unknown as IDBFactory;
    const caches = { keys: () => Promise.reject(new Error("no caches")), delete: vi.fn() };
    await expect(migrateLegacyStorage({ localStorage: broken, indexedDB: idb, caches, warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});
