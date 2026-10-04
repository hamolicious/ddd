import type { Database, PreparedStatement, SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import type { SqlParam, SqlStatement } from "../wasm/index.js";

import { sameName, type SqlFunction } from "./functions.js";

export const SEARCH_OPFS_DIRECTORY = "ddd-search";
export const SEARCH_DB_FILE = "/search.sqlite3";

export type SqlRow = Readonly<Record<string, SqlParam>>;

export interface SearchDatabase {
  readonly persistent: boolean;
  select(sql: string, params?: readonly SqlParam[]): SqlRow[];
  run(statements: readonly SqlStatement[]): void;
  exec(sql: string): void;
  register(functions: readonly SqlFunction[]): void;
  reset(): Promise<void>;
  wipe(): Promise<void>;
  close(): void;
}

export const SEARCH_WIPE_PENDING_KEY = "ddd:search-wipe-pending";

function remember(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(SEARCH_WIPE_PENDING_KEY, "1");
    else localStorage.removeItem(SEARCH_WIPE_PENDING_KEY);
  } catch {
  }
}

export function searchWipePending(): boolean {
  try {
    return localStorage.getItem(SEARCH_WIPE_PENDING_KEY) !== null;
  } catch {
    return false;
  }
}

export async function removeSearchFiles(): Promise<boolean> {
  const root = await navigator.storage?.getDirectory?.().catch(() => undefined);
  if (!root) {
    remember(false);
    return true;
  }
  await root.removeEntry(SEARCH_OPFS_DIRECTORY, { recursive: true }).catch(() => undefined);
  const gone = await root.getDirectoryHandle(SEARCH_OPFS_DIRECTORY).then(
    () => false,
    () => true,
  );
  remember(!gone);
  return gone;
}

export function markSearchWipePending(): void {
  remember(true);
}

let sqlite: Promise<Sqlite3Static> | undefined;

function loadSqlite(): Promise<Sqlite3Static> {
  sqlite ??= import("@sqlite.org/sqlite-wasm").then((mod) => mod.default());
  return sqlite;
}

export interface OpenOptions {
  readonly persistent?: boolean;
  readonly functions?: readonly SqlFunction[];
}

export async function openSearchDatabase(options: OpenOptions = {}): Promise<SearchDatabase> {
  const sqlite3 = await loadSqlite();
  if (options.persistent !== false && typeof sqlite3.installOpfsSAHPoolVfs === "function") {
    const pool = await sqlite3
      .installOpfsSAHPoolVfs({ name: "ddd-search", directory: SEARCH_OPFS_DIRECTORY })
      .catch(() => undefined);
    if (pool) return new SqliteDatabase(sqlite3, pool, options.functions ?? []);
  }
  return new SqliteDatabase(sqlite3, undefined, options.functions ?? []);
}

class SqliteDatabase implements SearchDatabase {
  #db: Database;
  readonly #cache = new Map<string, PreparedStatement>();
  #functions: readonly SqlFunction[];

  constructor(
    private readonly sqlite3: Sqlite3Static,
    private readonly pool: SAHPoolUtil | undefined,
    functions: readonly SqlFunction[],
  ) {
    this.#functions = functions;
    this.#db = this.#open();
  }

  get persistent(): boolean {
    return this.pool !== undefined;
  }

  select(sql: string, params: readonly SqlParam[] = []): SqlRow[] {
    const statement = this.#prepare(sql);
    try {
      if (params.length > 0) statement.bind([...params]);
      const rows: SqlRow[] = [];
      while (statement.step()) rows.push(statement.get({}) as SqlRow);
      return rows;
    } finally {
      statement.reset(true);
    }
  }

  run(statements: readonly SqlStatement[]): void {
    if (statements.length === 0) return;
    this.#db.transaction(() => {
      for (const { sql, params } of statements) {
        const statement = this.#prepare(sql);
        try {
          if (params.length > 0) statement.bind([...params]);
          statement.stepReset();
        } finally {
          statement.reset(true);
        }
      }
    });
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  register(functions: readonly SqlFunction[]): void {
    const taken = functions.find((added) => this.#functions.some((known) => sameName(known.name, added.name)));
    if (taken) throw new Error(`a SQL function named ${taken.name} is already registered`);
    this.#functions = [...this.#functions, ...functions];
    for (const fn of functions) this.#define(this.#db, fn);
  }

  async reset(): Promise<void> {
    this.#closeDb();
    if (this.pool) this.pool.unlink(SEARCH_DB_FILE);
    this.#db = this.#open();
    return Promise.resolve();
  }

  async wipe(): Promise<void> {
    this.#closeDb();
    if (this.pool) await this.pool.removeVfs().catch(() => false);
  }

  close(): void {
    this.#closeDb();
  }

  #open(): Database {
    const db = this.pool ? new this.pool.OpfsSAHPoolDb(SEARCH_DB_FILE) : new this.sqlite3.oo1.DB(":memory:", "c");
    for (const fn of this.#functions) this.#define(db, fn);
    return db;
  }

  #define(db: Database, fn: SqlFunction): void {
    db.createFunction(fn.name, (_context: unknown, ...args: unknown[]) => fn.call(args as SqlParam[]) as never, {
      arity: fn.arity,
      deterministic: fn.deterministic,
    });
  }

  #prepare(sql: string): PreparedStatement {
    let statement = this.#cache.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#cache.set(sql, statement);
    }
    return statement;
  }

  #closeDb(): void {
    for (const statement of this.#cache.values()) statement.finalize();
    this.#cache.clear();
    if (this.#db.isOpen()) this.#db.close();
  }
}
