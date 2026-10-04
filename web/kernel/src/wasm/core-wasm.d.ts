declare module "@ddd/core-wasm" {
  export default function init(
    options?: { module_or_path?: BufferSource | WebAssembly.Module | URL | string } | URL | string,
  ): Promise<unknown>;

  export function parse_document(text: string): string;

  export function evaluate_filter(filter_json: string, doc_json: string): boolean;

  export function core_semantics_version(): number;

  export function normalize_date(input: string): string;

  export function resolve_title(text: string): string;

  export function search_schema(): string;

  export function search_project(rows_json: string): string;

  export function search_remove(ids_json: string): string;

  export function search_compile(plan_json: string): string;

  export function search_encode_cursor(values_json: string): string;

  export function search_snippets(request_json: string): string;


  export function search_expand(plan_json: string, vocabulary_json: string): string;
  export function search_functions(): string;
  export function search_call(index: number, args: unknown[]): unknown;

  export class QueryEngine {
    constructor();
    static load(json: string): QueryEngine | undefined;
    upsert(rows_json: string): number;
    remove(ids_json: string): void;
    run(plan_json: string): string;
    to_json(): string;
    len(): number;
    is_empty(): boolean;
    free(): void;
  }
}
