/**
 * RENAME-HOP: carry this origin's pre-rename storage (life-manager / lm → ddd) over to
 * the names the current code uses, before anything opens it.
 *
 * One release only. The cleanup release deletes this file, its test, `rename-hop-move.ts`
 * and every line marked `RENAME-HOP`; the old names below exist nowhere else.
 *
 * - **localStorage**: `life-manager.` / `life-manager:` / `lm.` / `lm:` keys become
 *   `ddd.` / `ddd:` keys, unless the new key is already set; the old key goes either way.
 * - **IndexedDB**: `life-manager` (the replica) and every `life-manager:…` plugin database
 *   are copied, schema and records, to `ddd` / `ddd:…` at the same version, in bounded
 *   batches, counted, and only then is the old one deleted. A database whose new name
 *   already exists is left alone. `life-manager-search` is only deleted: it rebuilds.
 * - **Cache Storage**: the old caches are deleted; the service worker refills new ones.
 *
 * Never throws: a migration that fails leaves the old data where it was and the boot
 * carries on (a fresh replica re-downloads from the server). What is left behind is
 * reported ({@link MigrationOutcome.stranded}), and while any old database is still on the
 * device the old domain never clears itself or moves (`rename-hop-move.ts`): that database
 * may hold the only copy of an edit.
 *
 * The states a database pair can be found in at boot:
 *
 * | old | new | marker                 | what happens                                         |
 * |-----|-----|------------------------|------------------------------------------------------|
 * | yes | no  | —                      | copied, verified, old deleted                        |
 * | yes | yes | `copying:<new>`        | a copy was cut short: new dropped, copied again      |
 * | yes | yes | `copied:<old>`         | copy verified earlier, deletion was blocked: retried  |
 * | yes | yes | none                   | the new one was started fresh before any copy (no    |
 * |     |     |                        | listing, or a copy that failed): both kept, stranded |
 * | no  | any | —                      | nothing to do                                        |
 *
 * Without `indexedDB.databases()` (older browsers) the known names are probed instead:
 * opened without a version, with any upgrade aborted, so a probe never creates one.
 */

/** RENAME-HOP: old localStorage key prefix → new. */
const KEY_PREFIXES: readonly (readonly [string, string])[] = [
  ["life-manager.", "ddd."],
  ["life-manager:", "ddd:"],
  ["lm.", "ddd."],
  ["lm:", "ddd:"],
];

/** RENAME-HOP: the replica, renamed whole. */
const LEGACY_DB = "life-manager";
/** RENAME-HOP: plugin databases (`life-manager:attachments`, `:folder`, …). */
const LEGACY_DB_PREFIX = "life-manager:";
/** RENAME-HOP: the search index; deleted, the engine rebuilds it. */
const LEGACY_SEARCH_DB = "life-manager-search";
/** RENAME-HOP: every cache the old build named. */
const LEGACY_CACHES: ReadonlySet<string> = new Set(["life-manager:api", "lm-shell", "lm-plugins", "lm-runtime", "lm-meta"]);

/**
 * RENAME-HOP: set while a database is being copied. Found at the next boot with the old
 * database still there, it means the copy was cut short: the half-made new one is dropped
 * and the copy starts again.
 */
const COPYING_KEY = (name: string): string => `ddd.rename-hop.copying:${name}`;
/**
 * RENAME-HOP: set once a copy is verified, until the old database is gone. Found with both
 * still there, it means only the deletion is left (an old tab held the old one open).
 */
const COPIED_KEY = (legacy: string): string => `ddd.rename-hop.copied:${legacy}`;

/**
 * RENAME-HOP: every name the old build used, probed when `indexedDB.databases()` is
 * missing. `life-manager:*` names a plugin outside this list made cannot be found then.
 */
const KNOWN_LEGACY: readonly string[] = [
  LEGACY_DB,
  `${LEGACY_DB_PREFIX}attachments`,
  `${LEGACY_DB_PREFIX}folder`,
  `${LEGACY_DB_PREFIX}obsidian-importer`,
  LEGACY_SEARCH_DB,
];

/** RENAME-HOP: how long a probe or a deletion may wait (one queued behind a blocked deletion hears nothing). */
export const PROBE_TIMEOUT_MS = 2_000;

/** RENAME-HOP: why an old database is still on the device. */
export type StrandedReason =
  /** The copy failed (quota, a held-open database), or the old one could not be deleted yet. */
  | "not-moved"
  /** A new database was started fresh before the old one was copied: both are kept. */
  | "both-exist";

export interface MigrationOutcome {
  /** Old databases still on this device (the disposable search index aside), and why. */
  readonly stranded: ReadonlyMap<string, StrandedReason>;
}

/** Records per read and per write transaction: bounded memory on a database of hundreds of MB. */
export const BATCH = 500;

export interface MigrateDeps {
  readonly localStorage?: Storage | undefined;
  readonly indexedDB?: IDBFactory | undefined;
  readonly caches?: Pick<CacheStorage, "keys" | "delete"> | undefined;
  readonly locks?: Pick<LockManager, "request"> | undefined;
  /** Called while databases are copied: records done of the total. */
  readonly onProgress?: (done: number, total: number) => void;
  readonly warn?: (message: string, cause?: unknown) => void;
}

/** RENAME-HOP: the new name for an old database, or `undefined` when it is not one. */
export function renamedDatabase(name: string): string | undefined {
  if (name === LEGACY_DB) return "ddd";
  if (name.startsWith(LEGACY_DB_PREFIX)) return `ddd:${name.slice(LEGACY_DB_PREFIX.length)}`;
  return undefined;
}

/** RENAME-HOP: the new name for an old localStorage key, or `undefined`. */
export function renamedKey(key: string): string | undefined {
  for (const [from, to] of KEY_PREFIXES) if (key.startsWith(from)) return to + key.slice(from.length);
  return undefined;
}

/** RENAME-HOP: is this an old database that may hold data (the search index never does)? */
export function isLegacyDatabase(name: string): boolean {
  return renamedDatabase(name) !== undefined;
}

/**
 * RENAME-HOP: every database name on this origin — listed, or else probed among the known
 * old and new names. A name that cannot be probed counts as present: unknown is never gone.
 */
export async function databaseNames(idb: IDBFactory): Promise<Set<string>> {
  if (typeof idb.databases === "function") {
    try {
      const listed = await idb.databases();
      return new Set(listed.map((db) => db.name).filter((name): name is string => typeof name === "string"));
    } catch {
      /* fall through to probing */
    }
  }
  const candidates = new Set<string>();
  for (const name of KNOWN_LEGACY) {
    candidates.add(name);
    const renamed = renamedDatabase(name);
    if (renamed !== undefined) candidates.add(renamed);
  }
  const found = new Set<string>();
  for (const name of candidates) if (await probe(idb, name)) found.add(name);
  return found;
}

/** RENAME-HOP: the old databases (search index aside) still on this device. */
export async function legacyDatabasesLeft(idb: IDBFactory = globalThis.indexedDB): Promise<string[]> {
  return [...(await databaseNames(idb))].filter(isLegacyDatabase).sort();
}

export async function migrateLegacyStorage(deps: MigrateDeps = legacyStorageDeps()): Promise<MigrationOutcome> {
  const stranded = new Map<string, StrandedReason>();
  const warn = deps.warn ?? ((message: string, cause?: unknown) => console.warn(`[rename-hop] ${message}`, cause ?? ""));
  try {
    migrateLocalStorage(deps.localStorage);
  } catch (cause) {
    warn("localStorage could not be migrated", cause);
  }
  try {
    const keys = (await deps.caches?.keys()) ?? [];
    await Promise.all(keys.filter((key) => LEGACY_CACHES.has(key)).map((key) => deps.caches!.delete(key)));
  } catch (cause) {
    warn("old caches could not be deleted", cause);
  }
  const idb = deps.indexedDB;
  if (!idb) return { stranded };
  try {
    const run = (): Promise<void> => migrateDatabases(idb, deps, warn, stranded);
    // Two tabs booting at once must not both copy.
    if (deps.locks) await deps.locks.request("ddd:rename-hop", run);
    else await run();
  } catch (cause) {
    warn("IndexedDB could not be migrated", cause);
  }
  // Whatever the steps above reported, the device has the last word: an old database it
  // still lists is stranded, for whatever reason.
  try {
    const left = new Set(await legacyDatabasesLeft(idb));
    for (const name of left) if (!stranded.has(name)) stranded.set(name, "not-moved");
    for (const name of [...stranded.keys()]) if (!left.has(name)) stranded.delete(name);
  } catch (cause) {
    warn("could not tell which old databases are left", cause);
  }
  return { stranded };
}

/** RENAME-HOP: this page's real storage. */
export function legacyStorageDeps(): MigrateDeps {
  let storage: Storage | undefined;
  try {
    storage = globalThis.localStorage;
  } catch {
    storage = undefined;
  }
  return {
    localStorage: storage,
    indexedDB: globalThis.indexedDB,
    caches: globalThis.caches,
    locks: typeof navigator !== "undefined" ? navigator.locks : undefined,
  };
}

function migrateLocalStorage(storage: Storage | undefined): void {
  if (!storage) return;
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key !== null) keys.push(key);
  }
  for (const key of keys) {
    const renamed = renamedKey(key);
    if (renamed === undefined) continue;
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(renamed) === null) storage.setItem(renamed, value);
    storage.removeItem(key);
  }
}

async function migrateDatabases(
  idb: IDBFactory,
  deps: MigrateDeps,
  warn: (message: string, cause?: unknown) => void,
  stranded: Map<string, StrandedReason>,
): Promise<void> {
  const names = await databaseNames(idb);
  const marked = (key: string): boolean => (deps.localStorage?.getItem(key) ?? null) !== null;
  // A verified copy whose old database has gone since: nothing left to remember.
  forgetCopiedMarkers(deps.localStorage, names);
  if (names.has(LEGACY_SEARCH_DB)) await deleteDatabase(idb, LEGACY_SEARCH_DB);

  const work: { from: string; to: string }[] = [];
  for (const from of names) {
    const to = renamedDatabase(from);
    if (to === undefined) continue;
    if (!names.has(to)) {
      // RENAME-HOP: the new one is gone (site data cleared?): any old marker is stale.
      deps.localStorage?.removeItem(COPIED_KEY(from));
      work.push({ from, to });
      continue;
    }
    if (marked(COPYING_KEY(to))) {
      // RENAME-HOP: a copy cut short. The half-made new one is dropped — but only if
      // nothing holds it open, or the copy after it would wait on that tab forever.
      if (!(await deleteDatabase(idb, to, { strict: true }))) {
        warn(`"${to}" is held open by another tab; "${from}" is kept and copied later`);
        stranded.set(from, "not-moved");
        continue;
      }
      work.push({ from, to });
      continue;
    }
    if (marked(COPIED_KEY(from))) {
      // RENAME-HOP: copied and verified before; only the deletion is left.
      await deleteDatabase(idb, from);
      continue;
    }
    // RENAME-HOP: the new one was started before this one was copied. Either may hold the
    // only copy of an edit, so neither is touched; the old domain stays put (stranded).
    warn(`both "${from}" and "${to}" exist; keeping both`);
    stranded.set(from, "both-exist");
  }
  if (work.length === 0) return;

  const opened = await Promise.all(work.map(async (item) => ({ ...item, db: await openExisting(idb, item.from) })));
  let total = 0;
  for (const { db } of opened) total += db ? await countAll(db) : 0;
  let done = 0;
  deps.onProgress?.(0, total);
  for (const { from, to, db } of opened) {
    if (!db) continue;
    try {
      deps.localStorage?.setItem(COPYING_KEY(to), "1");
      await copyDatabase(db, idb, to, (n) => {
        done += n;
        deps.onProgress?.(done, total);
      });
      db.close();
      deps.localStorage?.setItem(COPIED_KEY(from), "1");
      deps.localStorage?.removeItem(COPYING_KEY(to));
      await deleteDatabase(idb, from);
    } catch (cause) {
      warn(`"${from}" could not be copied to "${to}"; keeping the old copy`, cause);
      stranded.set(from, "not-moved");
      db.close();
      await deleteDatabase(idb, to).catch(() => undefined);
      deps.localStorage?.removeItem(COPYING_KEY(to));
    }
  }
}

function forgetCopiedMarkers(storage: Storage | undefined, names: ReadonlySet<string>): void {
  if (!storage) return;
  const prefix = COPIED_KEY("");
  const stale: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(prefix) && !names.has(key.slice(prefix.length))) stale.push(key);
  }
  for (const key of stale) storage.removeItem(key);
}

const promised = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });

const finished = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

/**
 * Resolves once deleted — or once blocked: an old tab still holding it open keeps it until
 * that tab closes, and the deletion then completes on its own. `strict` resolves `false`
 * when blocked instead (the deletion still completes later).
 */
function deleteDatabase(idb: IDBFactory, name: string, options: { strict?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve, reject) => {
    // A deletion queued behind an earlier, still blocked one hears nothing at all until
    // that one completes: waiting this long counts as blocked.
    const timer = setTimeout(() => resolve(!options.strict), PROBE_TIMEOUT_MS);
    const settle = (deleted: boolean): void => {
      clearTimeout(timer);
      resolve(deleted);
    };
    const request = idb.deleteDatabase(name);
    request.onsuccess = () => settle(true);
    request.onblocked = () => settle(!options.strict);
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error(`"${name}" could not be deleted`));
    };
  });
}

/**
 * RENAME-HOP: does `name` exist? Opened without a version and with any upgrade aborted, so
 * probing never creates it. A probe that does not answer in time (a deletion pending
 * behind another tab) counts as present: unknown is never "gone".
 */
function probe(idb: IDBFactory, name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), PROBE_TIMEOUT_MS);
    const done = (found: boolean): void => {
      clearTimeout(timer);
      resolve(found);
    };
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(name);
    } catch {
      done(true);
      return;
    }
    let created = false;
    request.onupgradeneeded = () => {
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => {
      request.result.close();
      done(true);
    };
    request.onerror = (event) => {
      event.preventDefault();
      done(!created);
    };
  });
}

/** Open a database without creating it: `undefined` when it does not exist after all. */
function openExisting(idb: IDBFactory, name: string): Promise<IDBDatabase | undefined> {
  return new Promise((resolve, reject) => {
    const request = idb.open(name);
    let created = false;
    request.onupgradeneeded = () => {
      created = true;
      request.transaction?.abort();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => {
      if (created) {
        event.preventDefault();
        resolve(undefined);
      } else reject(request.error ?? new Error(`"${name}" could not be opened`));
    };
  });
}

async function countAll(db: IDBDatabase): Promise<number> {
  const stores = [...db.objectStoreNames];
  if (stores.length === 0) return 0;
  const tx = db.transaction(stores, "readonly");
  const counts = await Promise.all(stores.map((name) => promised(tx.objectStore(name).count())));
  return counts.reduce((a, b) => a + b, 0);
}

interface StoreSchema {
  readonly name: string;
  readonly keyPath: string | string[] | null;
  readonly autoIncrement: boolean;
  readonly indexes: readonly { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[];
}

function schemaOf(db: IDBDatabase): StoreSchema[] {
  const stores = [...db.objectStoreNames];
  if (stores.length === 0) return [];
  const tx = db.transaction(stores, "readonly");
  return stores.map((name) => {
    const store = tx.objectStore(name);
    return {
      name,
      keyPath: store.keyPath,
      autoIncrement: store.autoIncrement,
      indexes: [...store.indexNames].map((indexName) => {
        const index = store.index(indexName);
        return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
      }),
    };
  });
}

async function copyDatabase(source: IDBDatabase, idb: IDBFactory, target: string, copied: (n: number) => void): Promise<void> {
  const schema = schemaOf(source);
  const dest = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(target, source.version);
    request.onupgradeneeded = () => {
      for (const store of schema) {
        const made = request.result.createObjectStore(store.name, {
          ...(store.keyPath !== null ? { keyPath: store.keyPath } : {}),
          autoIncrement: store.autoIncrement,
        });
        for (const index of store.indexes) {
          made.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`"${target}" could not be created`));
    request.onblocked = () => reject(new Error(`"${target}" is held open elsewhere`));
  });
  try {
    for (const store of schema) {
      let after: IDBValidKey | undefined;
      for (;;) {
        const range = after === undefined ? null : IDBKeyRange.lowerBound(after, true);
        const read = source.transaction(store.name, "readonly").objectStore(store.name);
        const [keys, values] = await Promise.all([promised(read.getAllKeys(range, BATCH)), promised(read.getAll(range, BATCH))]);
        if (keys.length === 0) break;
        const tx = dest.transaction(store.name, "readwrite");
        const write = tx.objectStore(store.name);
        // Out-of-line keys go in explicitly; in-line ones are inside the value.
        keys.forEach((key, i) => (store.keyPath === null ? write.put(values[i], key) : write.put(values[i])));
        await finished(tx);
        copied(keys.length);
        if (keys.length < BATCH) break;
        after = keys[keys.length - 1];
      }
    }
    for (const store of schema) {
      const [from, to] = await Promise.all([
        promised(source.transaction(store.name, "readonly").objectStore(store.name).count()),
        promised(dest.transaction(store.name, "readonly").objectStore(store.name).count()),
      ]);
      if (from !== to) throw new Error(`"${store.name}": ${to} records copied of ${from}`);
    }
  } finally {
    dest.close();
  }
}
