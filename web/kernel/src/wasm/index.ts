/**
 * The shared Rust core, in the browser (SPEC §2: "parity … by construction").
 *
 * The kernel never reimplements parsing, title resolution or filter evaluation
 * in TypeScript — it calls the same code the server calls. This module is the
 * only place that touches the generated Wasm package; everything else depends on
 * {@link CoreBindings}, which is also what tests fake.
 *
 * Filter *compilation* stays server-side (SPEC §4.2): the client evaluates.
 */

import type { CoreMap, ProjectionRow } from "../protocol.js";

/** What `parse_document` returns (the JSON of `ParsedDocument`'s public half). */
export interface ParsedDocument {
  readonly title: string;
  readonly fm: CoreMap;
  readonly plugins: CoreMap;
  readonly fm_parse_error: boolean;
}

/** The filter DSL wire form (SPEC §4.2; grammar in `backend/crates/core/README.md`). */
export type FilterJson = { readonly [key: string]: unknown };

/** The row shape `evaluate_filter` expects — the evaluator's `Row`. */
export interface FilterRow {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly fm: CoreMap;
  readonly plugins: CoreMap;
  readonly created_at?: string;
  readonly updated_at?: string;
  readonly deleted: boolean;
}

/** **FROZEN INTERFACE.** The client-side surface of the shared core. */
export interface CoreBindings {
  parseDocument(text: string): ParsedDocument;
  evaluateFilter(filter: FilterJson, row: FilterRow): boolean;
  /** Mirrors `CORE_SEMANTICS_VERSION`; compared against `welcome`. */
  semanticsVersion(): number;
}

/** Project a stored projection row into the evaluator's row shape. */
export function filterRow(row: ProjectionRow): FilterRow {
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? "",
    fm: row.fm,
    plugins: row.plugins,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted: row.deleted,
  };
}

let cached: Promise<CoreBindings> | undefined;

/**
 * Load and initialize the Wasm core. Idempotent; concurrent callers share one
 * instantiation.
 *
 * `init` is passed nothing in the browser (wasm-bindgen resolves the `.wasm`
 * next to the JS); the Node harness hands in the bytes via `initInput`.
 */
export function loadCore(initInput?: BufferSource | WebAssembly.Module | URL | string): Promise<CoreBindings> {
  cached ??= (async () => {
    const mod = await import("@life-manager/core-wasm");
    await mod.default(initInput === undefined ? undefined : { module_or_path: initInput });
    return {
      parseDocument: (text: string) => JSON.parse(mod.parse_document(text)) as ParsedDocument,
      evaluateFilter: (filter: FilterJson, row: FilterRow) =>
        mod.evaluate_filter(JSON.stringify(filter), JSON.stringify(row)),
      semanticsVersion: () => mod.core_semantics_version(),
    } satisfies CoreBindings;
  })();
  return cached;
}

/** Drop the cached instance (tests only). */
export function resetCoreForTests(): void {
  cached = undefined;
}
