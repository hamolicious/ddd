/**
 * Ambient declaration of the generated shared-core Wasm package.
 *
 * `mise run wasm` builds `backend/crates/core` (feature `wasm`) into
 * `web/kernel/src/wasm/pkg/`, and `vite.config.ts` aliases the module id
 * `@life-manager/core-wasm` to the artifact there. The declaration is written by
 * hand on purpose: `npm run typecheck` must pass in a clean checkout that has
 * never run the Wasm build, and this is the one place where the ABI is spelled
 * out for the type checker.
 *
 * **These signatures are the Wasm ABI. They match
 * `backend/crates/core/src/wasm.rs` exactly; changing either side without the
 * other is a bug in both.**
 */
declare module "@life-manager/core-wasm" {
  /**
   * Initialize the module. `undefined` lets wasm-bindgen resolve the `.wasm`
   * next to the JS (the browser path); Node passes the bytes explicitly.
   */
  export default function init(
    options?: { module_or_path?: BufferSource | WebAssembly.Module | URL | string } | URL | string,
  ): Promise<unknown>;

  /**
   * Parse a document (SPEC §3.1, §3.4) with the same code the server runs.
   * Returns a JSON string: `{ title, fm, plugins, fm_parse_error }`.
   */
  export function parse_document(text: string): string;

  /**
   * Evaluate a filter-DSL expression against one projection row.
   * `filter_json` is the DSL wire form; `doc_json` is
   * `{ id, title, content, fm, plugins, created_at?, updated_at?, deleted }`.
   * Evaluation errors (type mismatches — the DSL compares same types only)
   * return `false`, mirroring the server's row-skipping semantics.
   */
  export function evaluate_filter(filter_json: string, doc_json: string): boolean;

  /** `life_manager_core::CORE_SEMANTICS_VERSION` — compared against `welcome`. */
  export function core_semantics_version(): number;

  /**
   * Normalize an ISO-8601 date the way materialization does (SPEC §3.4), so a
   * client that derives a value locally spells it the way the server would.
   * Returns the input unchanged when it is not a date.
   */
  export function normalize_date(input: string): string;

  /**
   * Resolve a document's title (`fm.title` → first ATX heading → first non-empty
   * line → `"Untitled"`) without a full `parse_document` round trip through JSON.
   */
  export function resolve_title(text: string): string;
}
