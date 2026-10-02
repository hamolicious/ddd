import { CLAUSE_OPS, VALUE_KINDS, newClauseId, type FilterClause } from "../../_shared/conditions.js";
import type { SearchSort, SearchSpec } from "./api.js";

import { RELEVANCE, type FilterDraft } from "./filter.js";

export const NO_FILTER: FilterDraft = { combine: "and", clauses: [] };

export const EMPTY_SPEC: SearchSpec = { query: "", filter: NO_FILTER };

export function filterOf(spec: SearchSpec): FilterDraft {
  return spec.filter as FilterDraft;
}

export function parseSpec(value: string): SearchSpec {
  const params = new URLSearchParams(value.replace(/^\?/, ""));
  const get = (name: string): string => params.get(name) ?? "";
  const includeMachine = get("machine") === "1";
  const filter: FilterDraft = {
    combine: get("match") === "any" ? "or" : "and",
    clauses: decodeClauses(get("where")),
    ...(includeMachine ? { includeMachine } : {}),
  };
  const sort = decodeSort(get("sort"));
  return { query: get("q").trim(), filter, ...(sort ? { sort } : {}) };
}

export function encodeSpec(spec: SearchSpec): string {
  const params = new URLSearchParams();
  const query = spec.query.trim();
  if (query !== "") params.set("q", query);
  const filter = filterOf(spec);
  if (filter.clauses.length > 0) {
    params.set("where", encodeClauses(filter.clauses));
    if (filter.combine === "or") params.set("match", "any");
  }
  if (filter.includeMachine === true) params.set("machine", "1");
  if (spec.sort) params.set("sort", `${spec.sort.field}:${spec.sort.direction}`);
  return params.toString();
}

export function sameSpec(a: SearchSpec, b: SearchSpec): boolean {
  return encodeSpec(a) === encodeSpec(b);
}

export function queryOf(hash: string): string {
  const path = hash.replace(/^#/, "");
  const index = path.indexOf("?");
  return index === -1 ? "" : path.slice(index + 1);
}

export function effectiveSort(spec: SearchSpec): SearchSort {
  const searching = spec.query.trim() !== "";
  if (spec.sort && (spec.sort.field !== RELEVANCE.field || searching)) return spec.sort;
  return searching ? { field: RELEVANCE.field, direction: "desc" } : { field: "updated_at", direction: "desc" };
}

export function documentPath(id: string, line?: number): string {
  const path = `/doc/${encodeURIComponent(id)}`;
  return line !== undefined && Number.isSafeInteger(line) && line >= 1 ? `${path}?line=${String(line)}` : path;
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function decodeSort(raw: string): SearchSort | undefined {
  const at = raw.lastIndexOf(":");
  if (at <= 0) return undefined;
  const field = raw.slice(0, at);
  const direction = raw.slice(at + 1);
  if (!FIELD.test(field) || (direction !== "asc" && direction !== "desc")) return undefined;
  return { field, direction };
}

function encodeClauses(clauses: readonly FilterClause[]): string {
  return JSON.stringify(
    clauses.map((clause) => {
      const flags = `${clause.negate === true ? "n" : ""}${clause.deep === true ? "d" : ""}`;
      const row = [clause.field, clause.op, clause.kind, clause.value];
      return flags === "" ? row : [...row, flags];
    }),
  );
}

function decodeClauses(raw: string): readonly FilterClause[] {
  if (raw === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((row: unknown): FilterClause[] => {
    if (!Array.isArray(row) || !row.slice(0, 4).every((part) => typeof part === "string")) return [];
    const [field, op, kind, value, flags] = row as [string, string, string, string, unknown];
    if (!CLAUSE_OPS.includes(op as FilterClause["op"]) || !VALUE_KINDS.includes(kind as FilterClause["kind"])) return [];
    const marks = typeof flags === "string" ? flags : "";
    return [
      {
        id: newClauseId(),
        field,
        op: op as FilterClause["op"],
        kind: kind as FilterClause["kind"],
        value,
        ...(marks.includes("n") ? { negate: true } : {}),
        ...(marks.includes("d") ? { deep: true } : {}),
      },
    ];
  });
}
