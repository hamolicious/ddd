/**
 * A query as data: the shared core's `query::Plan` (`backend/crates/core/README.md`
 * §6), the one shape the browser's engine, `POST /api/query` and a backend plugin's
 * `query` host call all answer.
 *
 * The kernel's older {@link Query} is translated into one by {@link planOf}, so every
 * local read — list, live query, search — runs on the same engine.
 */

import type { FilterJson } from "../wasm/index.js";
import type { Query, SortKey } from "./filter.js";

export interface QueryPlan {
  /** Ranked full-text search. */
  readonly text?: string;
  /** The filter DSL, `child_of` / `parent_of` included. */
  readonly filter?: FilterJson;
  /** `"fm.date"`, `"-updated_at"`, `"relevance"`. Empty: best match with text, else last updated. */
  readonly sort?: readonly string[];
  readonly trash?: "live" | "trashed" | "all";
  readonly limit?: number;
  /** Rows to skip; not with `cursor`. */
  readonly offset?: number;
  /** From a previous page's `next_cursor`; only pages the plan it came from. */
  readonly cursor?: string;
  /** Each text hit carries the line it matched on. */
  readonly snippets?: boolean;
}

export interface PlanSnippet {
  readonly text: string;
  /** UTF-16 offsets into `text`, ascending, non-overlapping. */
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  /** 1-based line of the content. */
  readonly line: number;
}

export interface PlanHit {
  readonly score: number;
  /** The indexed terms it matched, for highlighting. */
  readonly terms: readonly string[];
  readonly snippet?: PlanSnippet;
}

/** The engine's answer: ids in order, and why each matched the text. */
export interface PlanPage {
  readonly ids: readonly string[];
  /** Every match, before paging. */
  readonly total: number;
  readonly next_cursor?: string;
  readonly hits?: Readonly<Record<string, PlanHit>>;
}

/** Every row a local query may ask for: the core's `MAX_LIMIT`. */
export const ALL_ROWS = 1_000_000;

/** `{field, direction}` → the REST spelling the plan carries. */
export function sortToken(key: SortKey): string {
  return key.direction === "desc" ? `-${key.field}` : key.field;
}

/**
 * The plan a kernel {@link Query} means.
 *
 * Two defaults are the kernel's, not the engine's: no limit means every row, and no
 * sort without text means `id` ascending — the order `compareRows` falls back to.
 */
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

/** Does the filter join over the folder tree (`child_of`, `parent_of`)? */
export function hasRelations(filter: unknown): boolean {
  if (filter === null || typeof filter !== "object") return false;
  if (Array.isArray(filter)) return filter.some(hasRelations);
  for (const [key, value] of Object.entries(filter)) {
    if (key === "child_of" || key === "parent_of") return true;
    if ((key === "and" || key === "or" || key === "not") && hasRelations(value)) return true;
  }
  return false;
}
