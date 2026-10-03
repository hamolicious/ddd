import type { ProjectionRow } from "../protocol.js";
import type { CoreBindings } from "../wasm/index.js";
import type { SearchDatabase, SqlRow } from "./database.js";

export interface ProjectionStatus {
  readonly persistent: boolean;
  readonly documents: number;
  readonly version: string;
}

export interface ProjectionSync {
  add(rows: readonly ProjectionRow[]): number;
  commit(): number;
}

type StampedRow = ProjectionRow & { readonly stamp: string };

export function stampOf(row: ProjectionRow & { readonly seq?: number; readonly local?: boolean }): string {
  const content = row.content;
  return [
    row.materialized_version,
    row.updated_at,
    row.deleted ? "1" : "0",
    row.deleted_at ?? "",
    row.seq ?? "",
    row.local === true ? "1" : "0",
    row.title,
    content === undefined ? "-" : `${content.length}:${hash(content)}`,
  ].join("\u0000");
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export class SearchProjection {
  readonly version: string;
  #stamps = new Map<string, string>();

  constructor(
    private readonly core: CoreBindings,
    private readonly db: SearchDatabase,
  ) {
    this.version = `${core.searchSchema().version}.${core.semanticsVersion()}`;
  }

  async open(): Promise<void> {
    const schema = this.core.searchSchema();
    let current: string | undefined;
    try {
      current = this.db.select(schema.read_version)[0]?.value as string | undefined;
    } catch {
      current = undefined;
    }
    if (current !== this.version) {
      await this.db.reset();
      this.db.run([
        ...schema.statements.map((sql) => ({ sql, params: [] })),
        { sql: schema.write_version, params: [this.version] },
      ]);
    }
    this.#stamps = new Map(
      this.db.select(schema.read_stamps).map((row) => [row.id as string, row.stamp as string]),
    );
  }

  get persistent(): boolean {
    return this.db.persistent;
  }

  status(): ProjectionStatus {
    return { persistent: this.db.persistent, documents: this.#stamps.size, version: this.version };
  }

  apply(rows: readonly ProjectionRow[]): number {
    const changed: StampedRow[] = [];
    const purged: string[] = [];
    for (const row of rows) {
      if (row.purged) {
        if (this.#stamps.has(row.id)) purged.push(row.id);
        continue;
      }
      const stamp = stampOf(row);
      if (this.#stamps.get(row.id) === stamp) continue;
      changed.push({ ...row, stamp });
    }
    if (changed.length === 0 && purged.length === 0) return 0;
    this.db.run([...this.core.searchProject(changed), ...this.core.searchRemove(purged)]);
    for (const row of changed) this.#stamps.set(row.id, row.stamp);
    for (const id of purged) this.#stamps.delete(id);
    return changed.length + purged.length;
  }

  remove(ids: readonly string[]): number {
    const present = ids.filter((id) => this.#stamps.has(id));
    if (present.length === 0) return 0;
    this.db.run(this.core.searchRemove(present));
    for (const id of present) this.#stamps.delete(id);
    return present.length;
  }

  beginSync(): ProjectionSync {
    const seen = new Set<string>();
    return {
      add: (rows) => {
        for (const row of rows) if (!row.purged) seen.add(row.id);
        return this.apply(rows);
      },
      commit: () => this.remove([...this.#stamps.keys()].filter((id) => !seen.has(id))),
    };
  }

  select(sql: string): SqlRow[] {
    return this.db.select(sql);
  }

  async wipe(): Promise<void> {
    this.#stamps.clear();
    await this.db.wipe();
  }

  close(): void {
    this.db.close();
  }
}
