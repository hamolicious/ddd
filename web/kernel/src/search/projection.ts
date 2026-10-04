import type { ProjectionRow } from "../protocol.js";
import type { CompiledSearch, CoreBindings, SqlParam } from "../wasm/index.js";
import type { SearchDatabase, SqlRow } from "./database.js";
import { planError } from "./errors.js";

export interface ProjectionStatus {
  readonly persistent: boolean;
  readonly documents: number;
  readonly version: string;
}

export interface Applied {
  readonly changed: number;
  readonly sources: readonly string[];
}

export interface ProjectionSync {
  add(rows: readonly ProjectionRow[]): Applied;
  commit(): Applied;
}

const CHILD_SOURCES = ["fm", "links", "tasks", "attachments"] as const;

interface Known {
  readonly stamp: string;
  readonly deleted?: boolean;
  readonly fingerprints?: readonly number[];
}

function merge(a: Applied, b: Applied): Applied {
  return { changed: a.changed + b.changed, sources: [...new Set([...a.sources, ...b.sources])] };
}

export const NOTHING: Applied = { changed: 0, sources: [] };

export interface SearchRows {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly total?: number;
  readonly nextCursor?: string;
  readonly hits?: Readonly<Record<string, { readonly score: number; readonly terms: readonly string[] }>>;
  readonly sources: readonly string[];
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
  #known = new Map<string, Known>();

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
    this.#known = new Map(
      this.db.select(schema.read_stamps).map((row) => [row.id as string, { stamp: row.stamp as string }]),
    );
  }

  get persistent(): boolean {
    return this.db.persistent;
  }

  status(): ProjectionStatus {
    return { persistent: this.db.persistent, documents: this.#known.size, version: this.version };
  }

  apply(rows: readonly ProjectionRow[]): Applied {
    const changed: StampedRow[] = [];
    const purged: string[] = [];
    for (const row of rows) {
      if (row.purged) {
        if (this.#known.has(row.id)) purged.push(row.id);
        continue;
      }
      const stamp = stampOf(row);
      if (this.#known.get(row.id)?.stamp === stamp) continue;
      changed.push({ ...row, stamp });
    }
    if (changed.length === 0 && purged.length === 0) return NOTHING;
    const projected = this.core.searchProject(changed);
    this.db.run(projected.statements);
    const sources = new Set<string>(["documents"]);
    projected.documents.forEach((document, index) => {
      const before = this.#known.get(document.id);
      CHILD_SOURCES.forEach((source, slot) => {
        if (before?.fingerprints?.[slot] !== document.fingerprints[slot]) sources.add(source);
      });
      if (before?.deleted !== document.deleted) sources.add("links");
      this.#known.set(document.id, {
        stamp: changed[index]?.stamp ?? "",
        deleted: document.deleted,
        fingerprints: document.fingerprints,
      });
    });
    const removed = this.remove(purged);
    return merge({ changed: changed.length, sources: [...sources] }, removed);
  }

  remove(ids: readonly string[]): Applied {
    const present = ids.filter((id) => this.#known.has(id));
    if (present.length === 0) return NOTHING;
    this.db.run(this.core.searchRemove(present));
    const sources = new Set<string>(["documents", "links"]);
    for (const id of present) {
      const before = this.#known.get(id);
      CHILD_SOURCES.forEach((source, slot) => {
        if (before?.fingerprints?.[slot] !== 0) sources.add(source);
      });
      this.#known.delete(id);
    }
    return { changed: present.length, sources: [...sources] };
  }

  beginSync(): ProjectionSync {
    const seen = new Set<string>();
    return {
      add: (rows) => {
        for (const row of rows) if (!row.purged) seen.add(row.id);
        return this.apply(rows);
      },
      commit: () => this.remove([...this.#known.keys()].filter((id) => !seen.has(id))),
    };
  }

  compile(plan: unknown): CompiledSearch {
    const answer = this.core.searchCompile(plan);
    if ("error" in answer) throw planError(answer.error.kind, answer.error.message);
    return answer.compiled;
  }

  run(plan: unknown): SearchRows {
    let compiled = this.compile(plan);
    if (compiled.vocabulary) {
      const words = this.db
        .select(compiled.vocabulary.sql, compiled.vocabulary.params)
        .map((row) => row.term)
        .filter((term): term is string => typeof term === "string");
      compiled = this.compile(this.core.searchExpand(plan, words));
    }
    let raw = this.db.select(compiled.sql, compiled.params);
    let nextCursor: string | undefined;
    if (compiled.page_size !== null && raw.length > compiled.page_size) {
      raw = raw.slice(0, compiled.page_size);
      const last = raw[raw.length - 1];
      if (last && compiled.cursor_columns > 0) {
        const keys: SqlParam[] = [];
        for (let index = 0; index < compiled.cursor_columns; index++) keys.push(last[`k${index}`] ?? null);
        nextCursor = this.core.searchEncodeCursor(keys);
      }
    }
    let hits: Record<string, { readonly score: number; readonly terms: readonly string[] }> | undefined;
    let fuzzyTotal: number | undefined;
    if (compiled.fuzzy) {
      const page = this.core.searchFuzzy(
        compiled.fuzzy,
        raw.map((values) => ({
          title: typeof values.fuzzy_title === "string" ? values.fuzzy_title : "",
          content: typeof values.fuzzy_content === "string" ? values.fuzzy_content : "",
        })),
      );
      if (compiled.fuzzy.total) fuzzyTotal = page.total;
      hits = {};
      const ordered: SqlRow[] = [];
      for (const found of page.hits) {
        const values = raw[found.index];
        if (!values) continue;
        ordered.push(values);
        hits[String(values.fuzzy_id)] = { score: found.score, terms: found.terms };
      }
      raw = ordered;
    }
    const rows = raw.map((values) => decodeRow(compiled, values));
    if (compiled.snippets) {
      const snippets = this.core.searchSnippets(
        compiled.terms ?? [],
        raw.map((values) => (typeof values.snippet_source === "string" ? values.snippet_source : null)),
      );
      rows.forEach((row, index) => {
        row.snippet = snippets[index] ?? null;
      });
    }
    const total = fuzzyTotal ?? (compiled.total
      ? Number(Object.values(this.db.select(compiled.total.sql, compiled.total.params)[0] ?? {})[0] ?? 0)
      : undefined);
    return {
      rows,
      ...(total === undefined ? {} : { total }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
      ...(hits === undefined ? {} : { hits }),
      sources: compiled.sources,
    };
  }

  select(sql: string): SqlRow[] {
    return this.db.select(sql);
  }

  async wipe(): Promise<void> {
    this.#known.clear();
    await this.db.wipe();
  }

  close(): void {
    this.db.close();
  }
}

function decodeRow(compiled: CompiledSearch, values: SqlRow): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  compiled.columns.forEach((column, index) => {
    const raw = values[`c${index}`] ?? null;
    const value =
      column.decode === "bool"
        ? raw === null
          ? null
          : raw !== 0
        : column.decode === "json"
          ? typeof raw === "string"
            ? (JSON.parse(raw) as unknown)
            : raw
          : raw;
    const [outer, inner] = column.path;
    if (outer === undefined) return;
    if (inner === undefined) {
      row[outer] = value;
      return;
    }
    const nested = (row[outer] ??= {}) as Record<string, unknown>;
    nested[inner] = value;
  });
  return row;
}
