import type { Database, PreparedStatement, SAHPoolUtil, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

import type { SqlParam, SqlStatement } from "../wasm/index.js";

export const SEARCH_OPFS_DIRECTORY = "ddd-search";
export const SEARCH_DB_FILE = "/search.sqlite3";

export type SqlRow = Readonly<Record<string, SqlParam>>;

export interface SearchDatabase {
  readonly persistent: boolean;
  select(sql: string, params?: readonly SqlParam[]): SqlRow[];
  run(statements: readonly SqlStatement[]): void;
  exec(sql: string): void;
  reset(): Promise<void>;
  wipe(): Promise<void>;
  close(): void;
}

export async function removeSearchFiles(): Promise<void> {
  try {
    const root = await navigator.storage?.getDirectory?.();
    await root?.removeEntry(SEARCH_OPFS_DIRECTORY, { recursive: true });
  } catch {
  }
}

let sqlite: Promise<Sqlite3Static> | undefined;

function loadSqlite(): Promise<Sqlite3Static> {
  sqlite ??= import("@sqlite.org/sqlite-wasm").then((mod) => mod.default());
  return sqlite;
}

export interface OpenOptions {
  readonly persistent?: boolean;
}

export async function openSearchDatabase(options: OpenOptions = {}): Promise<SearchDatabase> {
  const sqlite3 = await loadSqlite();
  if (options.persistent !== false && typeof sqlite3.installOpfsSAHPoolVfs === "function") {
    const pool = await sqlite3
      .installOpfsSAHPoolVfs({ name: "ddd-search", directory: SEARCH_OPFS_DIRECTORY })
      .catch(() => undefined);
    if (pool) return new SqliteDatabase(sqlite3, pool);
  }
  return new SqliteDatabase(sqlite3, undefined);
}

class SqliteDatabase implements SearchDatabase {
  #db: Database;
  readonly #cache = new Map<string, PreparedStatement>();

  constructor(
    private readonly sqlite3: Sqlite3Static,
    private readonly pool: SAHPoolUtil | undefined,
  ) {
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
    if (this.pool) return new this.pool.OpfsSAHPoolDb(SEARCH_DB_FILE);
    return new this.sqlite3.oo1.DB(":memory:", "c");
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
