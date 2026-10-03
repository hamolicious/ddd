import type { ProjectionRow } from "../protocol.js";
import type { PlanPage, QueryPlan } from "./plan.js";
import type { SearchStats } from "./search.js";
import type { SqlRow } from "../search/database.js";
import type { Applied, ProjectionStatus, SearchRows } from "../search/projection.js";
import type { SerializedSearchError } from "../search/errors.js";

export type SearchRequest =
  | { readonly op: "open" }
  | { readonly op: "upsert"; readonly rows: readonly ProjectionRow[] }
  | { readonly op: "remove"; readonly ids: readonly string[] }
  | { readonly op: "run"; readonly plan: QueryPlan }
  | { readonly op: "persist"; readonly safeSeq: number }
  | { readonly op: "stats" }
  | {
      readonly op: "rebuild";
      readonly rows: readonly ProjectionRow[];
      readonly first: boolean;
      readonly last: boolean;
    }
  | { readonly op: "close" }
  | { readonly op: "projection.open" }
  | { readonly op: "projection.status" }
  | {
      readonly op: "projection.sync";
      readonly rows: readonly ProjectionRow[];
      readonly first: boolean;
      readonly last: boolean;
    }
  | { readonly op: "projection.apply"; readonly rows: readonly ProjectionRow[]; readonly purged: readonly string[] }
  | { readonly op: "projection.select"; readonly sql: string }
  | { readonly op: "projection.run"; readonly plan: unknown }
  | { readonly op: "projection.wipe" };

export type SearchResponseValue = void | number | Applied | PlanPage | SearchStats | ProjectionStatus | SearchRows | readonly SqlRow[];

export interface SearchRequestEnvelope {
  readonly id: number;
  readonly request: SearchRequest;
}

export type SearchResponseEnvelope =
  | { readonly id: number; readonly ok: true; readonly value: SearchResponseValue }
  | { readonly id: number; readonly ok: false; readonly error: string; readonly detail?: SerializedSearchError };
