import type { FilterJson } from "../wasm/index.js";
import type { Query, SortKey } from "./filter.js";

export interface QueryPlan {
  readonly text?: string;
  readonly filter?: FilterJson;
  readonly sort?: readonly string[];
  readonly trash?: "live" | "trashed" | "all";
  readonly limit?: number;
  readonly offset?: number;
  readonly cursor?: string;
  readonly snippets?: boolean;
}

export interface PlanSnippet {
  readonly text: string;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly line: number;
}

export interface PlanHit {
  readonly score: number;
  readonly terms: readonly string[];
  readonly snippet?: PlanSnippet;
}

export interface PlanPage {
  readonly ids: readonly string[];
  readonly total: number;
  readonly next_cursor?: string;
  readonly hits?: Readonly<Record<string, PlanHit>>;
}

export const ALL_ROWS = 1_000_000;

export function sortToken(key: SortKey): string {
  return key.direction === "desc" ? `-${key.field}` : key.field;
}

export function planOf(query: Query): QueryPlan {
  const text = query.search?.trim() ?? "";
  const sort = (query.sort ?? []).map(sortToken);
  return {
    ...(text !== "" ? { text } : {}),
    ...(query.filter ? { filter: query.filter } : {}),
    sort: sort.length > 0 ? sort : text !== "" ? ["relevance"] : ["id"],
    trash: query.includeDeleted === true ? "all" : "live",
    limit: query.limit ?? ALL_ROWS,
    ...(query.offset !== undefined && query.offset > 0 ? { offset: query.offset } : {}),
  };
}

export function hasRelations(filter: unknown): boolean {
  if (filter === null || typeof filter !== "object") return false;
  if (Array.isArray(filter)) return filter.some(hasRelations);
  for (const [key, value] of Object.entries(filter)) {
    if (key === "child_of" || key === "parent_of") return true;
    if ((key === "and" || key === "or" || key === "not") && hasRelations(value)) return true;
  }
  return false;
}
