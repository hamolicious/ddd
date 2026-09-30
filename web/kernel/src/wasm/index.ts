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
  /**
   * The tombstone instant, **omitted** on a live document rather than sent as
   * null: `deleted_at` is an addressable field of the DSL (M5 polish), so
   * `missing`/`exists` can tell the two apart, and Mongo stores it unset. Sending
   * `null` here would make the client answer `exists` where the server answers
   * `missing` for every live row in the workspace.
   */
  readonly deleted_at?: string;
  readonly deleted: boolean;
}

/**
 * **FROZEN INTERFACE.** The client-side surface of the shared core.
 *
 * It is the **whole** ABI now. `resolveTitle` and `normalizeDate` were the two exports
 * `wasm.rs` had and this file did not, and `web/CONTRACTS.md` listed the gap as open
 * under this area: `kernel.core.resolveTitle`/`normalizeDate` threw
 * `notImplemented`, and `harness/src/core.ts` reached past this interface into the
 * generated module to get at `normalize_date`. Both are closed here, and the closing
 * is the one kind of change this interface takes — additive, with the Rust side already
 * exporting what it adds.
 */
export interface CoreBindings {
  parseDocument(text: string): ParsedDocument;
  evaluateFilter(filter: FilterJson, row: FilterRow): boolean;
  /** Mirrors `CORE_SEMANTICS_VERSION`; compared against `welcome`. */
  semanticsVersion(): number;
  /**
   * `fm.title` → first ATX heading → first non-empty line → `"Untitled"`, without a
   * `parseDocument` round trip through JSON.
   */
  resolveTitle(text: string): string;
  /**
   * `Date::normalize_str` — the canonical ISO-8601 form materialization writes
   * (SPEC §3.4), so a value derived on this client sorts and compares the way the
   * server's would. Returns the input unchanged when it is not a date.
   */
  normalizeDate(input: string): string;
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
    ...(row.deleted_at === null ? {} : { deleted_at: row.deleted_at }),
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
      resolveTitle: (text: string) => mod.resolve_title(text),
      normalizeDate: (input: string) => mod.normalize_date(input),
    } satisfies CoreBindings;
  })();
  return cached;
}

/** Drop the cached instance (tests only). */
export function resetCoreForTests(): void {
  cached = undefined;
}
