/**
 * A search as one query string: what the list's URL carries after `#/?`, and what a
 * saved-search note holds (`saved.ts`).
 *
 * `lm/router.route` patterns match `:name` *path* segments, so a query string is not
 * something the router hands back — and a search that cannot be linked to, or that loses
 * itself on reload or on "back" from a result, is a worse answer than parsing it here.
 *
 * | Key       | Holds                                                                 |
 * |-----------|-----------------------------------------------------------------------|
 * | `q`       | the text                                                              |
 * | `where`   | the filter rows, each `[field, op, kind, value]` plus a flags string (`n` "not", `d` "nested") |
 * | `match`   | `any` when the rows combine with "or"                                 |
 * | `machine` | `1` to include machine-owned documents                                |
 * | `sort`    | `field:asc` or `field:desc`                                           |
 *
 * Filter rows are kept as typed, half-finished ones included, so reload shows the editor as
 * it was. Everything is left out when it is the default, so the plain list is `#/`.
 *
 * How a search is *shown* is not part of it: each view plugin keeps its own settings in
 * its own `%%%` section of a saved-search note. Older `view` and `v.<key>` params are
 * ignored.
 */

import { CLAUSE_OPS, VALUE_KINDS, newClauseId, type FilterClause } from "../../_shared/conditions.js";
import type { SearchSort, SearchSpec } from "./api.js";

import { RELEVANCE, type FilterDraft } from "./filter.js";

/** No filter: what a search starts with, and what a query string without one means. */
export const NO_FILTER: FilterDraft = { combine: "and", clauses: [] };

/** The search with nothing in it: every document, last updated first. */
export const EMPTY_SPEC: SearchSpec = { query: "", filter: NO_FILTER };

/** A search's filter as the filter code types it; `parse` is what guarantees the shape. */
export function filterOf(spec: SearchSpec): FilterDraft {
  return spec.filter as FilterDraft;
}

/** The search a query string describes (`q=milk&where=…`, no leading `?`). Junk is dropped. */
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

/** The query string for a search, defaults left out; `""` for {@link EMPTY_SPEC}. */
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

/** Whether two searches say the same thing, filter row ids aside. */
export function sameSpec(a: SearchSpec, b: SearchSpec): boolean {
  return encodeSpec(a) === encodeSpec(b);
}

/** The query string part of a hash route, `""` when it has none. */
export function queryOf(hash: string): string {
  const path = hash.replace(/^#/, "");
  const index = path.indexOf("?");
  return index === -1 ? "" : path.slice(index + 1);
}

/**
 * The order rows are in: the search's own, or the default — best match while there is
 * text, last updated first otherwise. "Best match" without text has nothing to rank by
 * and falls back the same way.
 */
export function effectiveSort(spec: SearchSpec): SearchSort {
  const searching = spec.query.trim() !== "";
  if (spec.sort && (spec.sort.field !== RELEVANCE.field || searching)) return spec.sort;
  return searching ? { field: RELEVANCE.field, direction: "desc" } : { field: "updated_at", direction: "desc" };
}

/**
 * The hash path for one result, deep-linked to the line the snippet came from. `?line=`
 * is `document-surface`'s query, spelled here as a literal: a URL is an address both
 * sides agree on, and the surface ignores a `line` it cannot use.
 */
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

/** Rows out of `where`; a row that is not one — hand-edited, or from a later version — is dropped. */
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
