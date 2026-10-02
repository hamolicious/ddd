import type { ProjectionRow } from "../protocol.js";
import type { PlanPage, QueryPlan } from "./plan.js";
import type { SearchStats } from "./search.js";

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
  | { readonly op: "close" };

export type SearchResponseValue = void | PlanPage | SearchStats;

export interface SearchRequestEnvelope {
  readonly id: number;
  readonly request: SearchRequest;
}

export type SearchResponseEnvelope =
  | { readonly id: number; readonly ok: true; readonly value: SearchResponseValue }
  | { readonly id: number; readonly ok: false; readonly error: string };
