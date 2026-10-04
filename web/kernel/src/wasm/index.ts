import type { CoreMap, ProjectionRow } from "../protocol.js";
import type { PlanPage, QueryPlan } from "../query/plan.js";

export interface ParsedDocument {
  readonly title: string;
  readonly fm: CoreMap;
  readonly plugins: CoreMap;
  readonly fm_parse_error: boolean;
}

export type FilterJson = { readonly [key: string]: unknown };

export interface FilterRow {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly fm: CoreMap;
  readonly plugins: CoreMap;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly deleted_at?: string;
  readonly deleted: boolean;
}

export interface CoreQueryEngine {
  upsert(rows: readonly ProjectionRow[]): number;
  remove(ids: readonly string[]): void;
  run(plan: QueryPlan): PlanPage;
  toJson(): string;
  readonly size: number;
  free(): void;
}

export type SqlParam = string | number | null;

export interface SqlFunctionInfo {
  readonly name: string;
  readonly arity: number;
  readonly deterministic: boolean;
}

export interface SqlStatement {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

export interface SearchProjected {
  readonly statements: readonly SqlStatement[];
  readonly documents: readonly {
    readonly id: string;
    readonly deleted: boolean;
    readonly fingerprints: readonly [number, number, number, number];
  }[];
}

export interface SearchSchema {
  readonly version: number;
  readonly statements: readonly string[];
  readonly read_version: string;
  readonly write_version: string;
  readonly read_stamps: string;
}

export interface CompiledSearch {
  readonly sql: string;
  readonly params: readonly SqlParam[];
  readonly columns: readonly { readonly path: readonly string[]; readonly decode: "plain" | "bool" | "json" }[];
  readonly cursor_columns: number;
  readonly page_size: number | null;
  readonly total?: { readonly sql: string; readonly params: readonly SqlParam[] };
  readonly sources: readonly string[];
  readonly terms?: readonly string[];
  readonly snippets: boolean;
  readonly hits?: boolean;
  readonly vocabulary?: { readonly sql: string; readonly params: readonly SqlParam[] };
}

export interface SearchSnippet {
  readonly text: string;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly line: number;
}

export interface SearchPlanProblem {
  readonly kind: string;
  readonly message: string;
}

export type SearchCompileAnswer =
  | { readonly compiled: CompiledSearch }
  | { readonly error: SearchPlanProblem };

export interface CoreBindings {
  parseDocument(text: string): ParsedDocument;
  evaluateFilter(filter: FilterJson, row: FilterRow): boolean;
  semanticsVersion(): number;
  resolveTitle(text: string): string;
  normalizeDate(input: string): string;
  queryEngine(saved?: string): CoreQueryEngine | undefined;
  searchSchema(): SearchSchema;
  searchProject(rows: readonly unknown[]): SearchProjected;
  searchRemove(ids: readonly string[]): readonly SqlStatement[];
  searchCompile(plan: unknown): SearchCompileAnswer;
  searchEncodeCursor(values: readonly SqlParam[]): string;
  searchSnippets(terms: readonly string[], contents: readonly (string | null)[]): readonly (SearchSnippet | null)[];
  searchExpand(plan: unknown, vocabulary: readonly string[]): unknown;
  searchFunctions(): readonly SqlFunctionInfo[];
  searchCall(index: number, args: readonly SqlParam[]): SqlParam;
}

export function filterRow(row: ProjectionRow): FilterRow {
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? "",
    fm: row.fm,
    plugins: row.plugins,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.deleted_at === null ? {} : { deleted_at: row.deleted_at }),
    deleted: row.deleted,
  };
}

let cached: Promise<CoreBindings> | undefined;

export function loadCore(initInput?: BufferSource | WebAssembly.Module | URL | string): Promise<CoreBindings> {
  cached ??= (async () => {
    const mod = await import("@ddd/core-wasm");
    await mod.default(initInput === undefined ? undefined : { module_or_path: initInput });
    return {
      parseDocument: (text: string) => JSON.parse(mod.parse_document(text)) as ParsedDocument,
      evaluateFilter: (filter: FilterJson, row: FilterRow) =>
        mod.evaluate_filter(JSON.stringify(filter), JSON.stringify(row)),
      semanticsVersion: () => mod.core_semantics_version(),
      resolveTitle: (text: string) => mod.resolve_title(text),
      normalizeDate: (input: string) => mod.normalize_date(input),
      queryEngine: (saved?: string) => {
        const engine = saved === undefined ? new mod.QueryEngine() : mod.QueryEngine.load(saved);
        return engine === undefined ? undefined : wrapEngine(engine);
      },
      searchSchema: () => JSON.parse(mod.search_schema()) as SearchSchema,
      searchProject: (rows: readonly unknown[]) => {
        const answer = JSON.parse(mod.search_project(JSON.stringify(rows))) as SearchProjected | { readonly error: string };
        if ("error" in answer) throw new Error(answer.error);
        return answer;
      },
      searchRemove: (ids: readonly string[]) => statementsOf(mod.search_remove(JSON.stringify(ids))),
      searchCompile: (plan: unknown) => {
        const answer = JSON.parse(mod.search_compile(JSON.stringify(plan))) as
          | { readonly compiled: CompiledSearch }
          | { readonly error: { readonly kind: string }; readonly message: string };
        return "compiled" in answer
          ? { compiled: answer.compiled }
          : { error: { kind: answer.error.kind, message: answer.message } };
      },
      searchEncodeCursor: (values: readonly SqlParam[]) => mod.search_encode_cursor(JSON.stringify(values)),
      searchSnippets: (terms: readonly string[], contents: readonly (string | null)[]) =>
        JSON.parse(mod.search_snippets(JSON.stringify({ terms, contents }))) as readonly (SearchSnippet | null)[],
      searchExpand: (plan: unknown, vocabulary: readonly string[]) =>
        JSON.parse(mod.search_expand(JSON.stringify(plan), JSON.stringify(vocabulary))) as unknown,
      searchFunctions: () => JSON.parse(mod.search_functions()) as readonly SqlFunctionInfo[],
      searchCall: (index: number, args: readonly SqlParam[]) => mod.search_call(index, [...args]) as SqlParam,
    } satisfies CoreBindings;
  })();
  return cached;
}

function statementsOf(json: string): readonly SqlStatement[] {
  const answer = JSON.parse(json) as { readonly statements: readonly SqlStatement[] } | { readonly error: string };
  if ("error" in answer) throw new Error(answer.error);
  return answer.statements;
}

function wrapEngine(engine: import("@ddd/core-wasm").QueryEngine): CoreQueryEngine {
  return {
    upsert: (rows) => engine.upsert(JSON.stringify(rows)),
    remove: (ids) => engine.remove(JSON.stringify(ids)),
    run: (plan) => {
      const answer = JSON.parse(engine.run(JSON.stringify(plan))) as
        | { readonly page: PlanPage }
        | { readonly error: string };
      if ("error" in answer) throw new Error(answer.error);
      return answer.page;
    },
    toJson: () => engine.to_json(),
    get size() {
      return engine.len();
    },
    free: () => engine.free(),
  };
}

export function resetCoreForTests(): void {
  cached = undefined;
}
