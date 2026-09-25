/**
 * Local filtering and sorting over projection rows (SPEC §4.2).
 *
 * The DSL is evaluated by the **shared Wasm core**, never by a TypeScript
 * reimplementation — that is the whole point of SPEC §2. Sorting is the one
 * exception: comparison of already-typed projection values is trivial and
 * deterministic, and doing it in JS avoids a Wasm call per comparison. Its
 * semantics must match `core::filter::evaluator::compare_rows`.
 *
 * **FROZEN INTERFACE.**
 */

import type { CoreValue, ProjectionRow } from "../protocol.js";
import { filterRow, type CoreBindings, type FilterJson } from "../wasm/index.js";

export type SortDirection = "asc" | "desc";

/** One sort key: a dotted projection path (`title`, `fm.path`, `updated_at`). */
export interface SortKey {
  readonly field: string;
  readonly direction: SortDirection;
}

/** `"fm.path"`, `"-updated_at"`, `"title:desc"` — the same spellings REST accepts. */
export function parseSortKey(input: string): SortKey {
  if (input.startsWith("-")) return { field: input.slice(1), direction: "desc" };
  const [field, direction] = input.split(":", 2);
  return {
    field: field ?? input,
    direction: direction === "desc" ? "desc" : "asc",
  };
}

export interface Query {
  readonly filter?: FilterJson;
  readonly sort?: readonly SortKey[];
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
  /** Default `false`: tombstoned rows are the Trash view's business. */
  readonly includeDeleted?: boolean;
}

export interface QueryResult {
  readonly rows: readonly ProjectionRow[];
  /** Matches before `limit`/`offset` — the count a UI shows. */
  readonly total: number;
}

/** Resolve a dotted path against a row. `undefined` ⇒ missing (≠ null). */
export function resolvePath(row: ProjectionRow, path: string): CoreValue | undefined {
  const segments = path.split(".");
  const head = segments[0];
  if (head === undefined) return undefined;

  let current: CoreValue | undefined;
  switch (head) {
    case "id":
    case "title":
    case "content":
    case "materialized_version":
    case "created_at":
    case "updated_at":
    case "deleted_at":
      current = (row as unknown as Record<string, CoreValue>)[head];
      break;
    case "deleted":
      current = row.deleted;
      break;
    case "fm":
    case "plugins":
      current = row[head];
      break;
    default:
      return undefined;
  }

  for (const segment of segments.slice(1)) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, CoreValue>)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Ordering — a line-by-line mirror of `core::filter::evaluator`
// ---------------------------------------------------------------------------

/**
 * A resolved sort field, carrying the same distinction Rust's `FieldRef` does.
 *
 * The kinds matter because Rust compares *fixed* projection columns by their
 * schema type (string / bool / date) and *dynamic* `fm`/`plugins` values through
 * the value model's type ranking. Collapsing the two would reorder rows the
 * moment a workspace holds heterogeneous frontmatter, which is normal.
 */
type ResolvedField =
  | { readonly kind: "missing" }
  | { readonly kind: "str"; readonly text: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "date"; readonly canonical: string }
  | { readonly kind: "value"; readonly value: CoreValue };

const MISSING: ResolvedField = { kind: "missing" };

/**
 * Mirror of `core::filter::evaluator::resolve_field`.
 *
 * Deliberately *narrower* than {@link resolvePath}: `materialized_version` is an
 * unknown root to the shared core and therefore sorts as missing here too.
 * Widening this on the client alone would make client and server disagree about
 * an ordering, which is the one thing this file exists to prevent.
 *
 * `deleted_at` used to be on that narrower list and no longer is: the M5 polish
 * added it to `core::filter::evaluator::Row` and to the corpus (it is what
 * `doc-list`'s Trash view sorts by), so leaving it missing here was the exact
 * disagreement described above — `-deleted_at` returned insertion order on the
 * client and tombstone order from the server.
 */
function resolveField(row: ProjectionRow, path: string): ResolvedField {
  const segments = path.split(".");
  const root = segments[0];
  switch (root) {
    case "id":
      return { kind: "str", text: row.id };
    case "title":
      return { kind: "str", text: row.title };
    case "content":
      // `include_content: false` subscriptions carry no text; the evaluator's
      // row shape substitutes "" for it (see `filterRow`), so ordering does too.
      return { kind: "str", text: row.content ?? "" };
    case "deleted":
      return { kind: "bool", value: row.deleted };
    case "created_at":
    case "updated_at":
    case "deleted_at": {
      // PROTOCOL.md §2.1: every wire timestamp is canonical RFC 3339 with
      // millisecond precision, and `core::date` guarantees byte-wise order over
      // canonical forms *is* chronological order — so no parsing is needed (and
      // parsing here would be a TypeScript reimplementation of core semantics).
      const value = row[root];
      return typeof value === "string" && value.length > 0
        ? { kind: "date", canonical: value }
        : MISSING;
    }
    case "fm":
    case "plugins":
      return walk(row[root], segments.slice(1));
    default:
      return MISSING;
  }
}

/** Mirror of `evaluator::walk`: a bare `fm` / `plugins` root resolves to missing. */
function walk(map: CoreValue, segments: readonly string[]): ResolvedField {
  const first = segments[0];
  if (first === undefined) return MISSING;
  if (!isMap(map)) return MISSING;
  let current = map[first];
  if (current === undefined) return MISSING;
  for (const segment of segments.slice(1)) {
    if (!isMap(current)) return MISSING;
    const next: CoreValue | undefined = current[segment];
    if (next === undefined) return MISSING;
    current = next;
  }
  return { kind: "value", value: current };
}

function isMap(value: CoreValue | undefined): value is { readonly [key: string]: CoreValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Byte-wise string comparison — `str::cmp` in Rust, which orders by UTF-8 bytes.
 *
 * `a < b` in JavaScript orders by UTF-16 code *units*, and the two disagree for
 * astral characters: `"～" < "\u{1f600}"` is true in UTF-8 byte order and
 * false in UTF-16 code-unit order. Remapping surrogates above the BMP restores
 * code-point order, which is exactly UTF-8 byte order.
 */
export function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    const left = a.charCodeAt(i);
    const right = b.charCodeAt(i);
    if (left === right) continue;
    const orderedLeft = left >= 0xd800 && left <= 0xdfff ? left + 0x10000 : left;
    const orderedRight = right >= 0xd800 && right <= 0xdfff ? right + 0x10000 : right;
    return orderedLeft < orderedRight ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Mirror of `f64::total_cmp`: −NaN < −∞ < … < −0 < +0 < … < +∞ < NaN. */
function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b) {
    // Only ±0 can reach here with different bit patterns.
    const left = Object.is(a, -0) ? 0 : 1;
    const right = Object.is(b, -0) ? 0 : 1;
    return left === right ? 0 : left < right ? -1 : 1;
  }
  // At least one is NaN; NaN sorts last, and two NaNs are equal for ordering.
  const leftNaN = Number.isNaN(a);
  const rightNaN = Number.isNaN(b);
  if (leftNaN && rightNaN) return 0;
  return leftNaN ? 1 : -1;
}

/** Mirror of `evaluator::order_values::rank`: the value-model type order. */
function rank(value: CoreValue): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number") return 2;
  if (typeof value === "string") return 3;
  if (Array.isArray(value)) return 4;
  return 5;
}

/** Mirror of `evaluator::order_values`. */
function orderValues(a: CoreValue, b: CoreValue): number {
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank < 0 ? -1 : 1;
  if (a === null || b === null) return 0;
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return compareNumbers(a, b);
  if (typeof a === "string" && typeof b === "string") return compareStrings(a, b);
  if (Array.isArray(a) && Array.isArray(b)) {
    const shared = Math.min(a.length, b.length);
    for (let i = 0; i < shared; i += 1) {
      const ordering = orderValues(a[i] as CoreValue, b[i] as CoreValue);
      if (ordering !== 0) return ordering;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
  if (isMap(a) && isMap(b)) {
    // `core::value::Map` is a `BTreeMap`: iteration is key order, not insertion
    // order. The server serializes it sorted already; sorting again is free
    // insurance against a row that travelled through something that reordered it.
    const left = Object.keys(a).sort(compareStrings);
    const right = Object.keys(b).sort(compareStrings);
    const shared = Math.min(left.length, right.length);
    for (let i = 0; i < shared; i += 1) {
      const leftKey = left[i] as string;
      const rightKey = right[i] as string;
      const byKey = compareStrings(leftKey, rightKey);
      if (byKey !== 0) return byKey;
      const byValue = orderValues(a[leftKey] as CoreValue, b[rightKey] as CoreValue);
      if (byValue !== 0) return byValue;
    }
    return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
  }
  return 0;
}

/** Mirror of `evaluator::order_fields`: mixed kinds compare equal (and cannot occur). */
function orderFields(a: ResolvedField, b: ResolvedField): number {
  if (a.kind === "str" && b.kind === "str") return compareStrings(a.text, b.text);
  if (a.kind === "bool" && b.kind === "bool") return a.value === b.value ? 0 : a.value ? 1 : -1;
  if (a.kind === "date" && b.kind === "date") return compareStrings(a.canonical, b.canonical);
  if (a.kind === "value" && b.kind === "value") return orderValues(a.value, b.value);
  return 0;
}

/**
 * Compare two rows by `sort`. Must stay equal to
 * `core::filter::evaluator::compare_rows`: missing sorts last, then by type
 * order (null < bool < number < string < list < map), then by value; `id` is the
 * implicit final tiebreaker so paging is deterministic.
 *
 * **Equal to the comparator, not to Mongo.** The two engines are the same on every row
 * that *has* the sort key and deliberately differ on rows that do not: this puts a missing
 * key last in both directions, while `GET /api/documents` sorts in Mongo, where an absent
 * field is Null — the lowest BSON type — and therefore comes **first** ascending. Closing
 * that means changing `compare_rows` and this mirror in one commit, or teaching
 * `filter::mongo::compile_sort` to emit an `$ifNull` projection; it is parked, and
 * `crates/server/tests/documents_query.rs` pins both sides so it stays a decision.
 *
 * It matters most on `deleted_at`, which is the only *fixed* root that can be absent and
 * is an advertised sort key (`doc-list`'s Trash order). `?trash=all&sort=deleted_at` is
 * where the split is visible: live documents have no `deleted_at`, so the server returns
 * them first and this returns them last. `-deleted_at` — the direction the Trash view
 * actually uses — agrees, because there the present values lead either way.
 */
export function compareRows(
  a: ProjectionRow,
  b: ProjectionRow,
  sort: readonly SortKey[],
): number {
  for (const key of sort) {
    const left = resolveField(a, key.field);
    const right = resolveField(b, key.field);
    const leftMissing = left.kind === "missing";
    const rightMissing = right.kind === "missing";
    let ordering: number;
    if (leftMissing && rightMissing) {
      ordering = 0;
    } else if (leftMissing) {
      return 1; // missing last, regardless of direction
    } else if (rightMissing) {
      return -1;
    } else {
      const raw = orderFields(left, right);
      ordering = key.direction === "asc" ? raw : -raw;
    }
    if (ordering !== 0) return ordering;
  }
  return compareStrings(a.id, b.id);
}

/** Filter evaluation over rows. Backed by the Wasm core. */
export interface FilterEvaluator {
  matches(filter: FilterJson, row: ProjectionRow): boolean;
}

export class WasmFilterEvaluator implements FilterEvaluator {
  constructor(private readonly core: CoreBindings) {}

  matches(filter: FilterJson, row: ProjectionRow): boolean {
    return this.core.evaluateFilter(filter, filterRow(row));
  }
}
