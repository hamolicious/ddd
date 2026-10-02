import type { CoreValue, ProjectionRow } from "../protocol.js";
import { filterRow, type CoreBindings, type FilterJson } from "../wasm/index.js";

export type SortDirection = "asc" | "desc";

export interface SortKey {
  readonly field: string;
  readonly direction: SortDirection;
}

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
  readonly includeDeleted?: boolean;
}

export interface QueryResult {
  readonly rows: readonly ProjectionRow[];
  readonly total: number;
}

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

type ResolvedField =
  | { readonly kind: "missing" }
  | { readonly kind: "str"; readonly text: string }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "date"; readonly canonical: string }
  | { readonly kind: "value"; readonly value: CoreValue };

const MISSING: ResolvedField = { kind: "missing" };

function resolveField(row: ProjectionRow, path: string): ResolvedField {
  const segments = path.split(".");
  const root = segments[0];
  switch (root) {
    case "id":
      return { kind: "str", text: row.id };
    case "title":
      return { kind: "str", text: row.title };
    case "content":
      return { kind: "str", text: row.content ?? "" };
    case "deleted":
      return { kind: "bool", value: row.deleted };
    case "created_at":
    case "updated_at":
    case "deleted_at": {
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

function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  if (a === b) {
    const left = Object.is(a, -0) ? 0 : 1;
    const right = Object.is(b, -0) ? 0 : 1;
    return left === right ? 0 : left < right ? -1 : 1;
  }
  const leftNaN = Number.isNaN(a);
  const rightNaN = Number.isNaN(b);
  if (leftNaN && rightNaN) return 0;
  return leftNaN ? 1 : -1;
}

function rank(value: CoreValue): number {
  if (value === null) return 0;
  if (typeof value === "boolean") return 1;
  if (typeof value === "number") return 2;
  if (typeof value === "string") return 3;
  if (Array.isArray(value)) return 4;
  return 5;
}

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

function orderFields(a: ResolvedField, b: ResolvedField): number {
  if (a.kind === "str" && b.kind === "str") return compareStrings(a.text, b.text);
  if (a.kind === "bool" && b.kind === "bool") return a.value === b.value ? 0 : a.value ? 1 : -1;
  if (a.kind === "date" && b.kind === "date") return compareStrings(a.canonical, b.canonical);
  if (a.kind === "value" && b.kind === "value") return orderValues(a.value, b.value);
  return 0;
}

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
      return 1;
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

export interface FilterEvaluator {
  matches(filter: FilterJson, row: ProjectionRow): boolean;
}

export class WasmFilterEvaluator implements FilterEvaluator {
  constructor(private readonly core: CoreBindings) {}

  matches(filter: FilterJson, row: ProjectionRow): boolean {
    return this.core.evaluateFilter(filter, filterRow(row));
  }
}
