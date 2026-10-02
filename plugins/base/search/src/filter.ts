import type { FilterJson, SortKey } from "@kernel";

import {
  buildConditions,
  clauseProblem,
  type ConditionContext,
  type Conditions,
} from "../../_shared/conditions.js";
import { withoutMachineDocuments } from "../../_shared/machine-docs.js";

export {
  FIELD_OPTIONS,
  VALUELESS_OPS,
  buildClause,
  buildLiteral,
  clauseProblem,
  describeClause,
  isFieldPathShaped,
  type ClauseOp,
  type FieldOption,
  type FilterClause,
  type ValueKind,
} from "../../_shared/conditions.js";
import type { FieldOption } from "../../_shared/conditions.js";

export interface FilterDraft extends Conditions {
  readonly includeMachine?: boolean;
}

export const SORT_OPTIONS: readonly FieldOption[] = [
  { field: "updated_at", label: "Last updated", kind: "date", sortable: true },
  { field: "created_at", label: "Created", kind: "date", sortable: true },
  { field: "title", label: "Title", kind: "str", sortable: true },
  { field: "id", label: "Id", kind: "str", sortable: true },
];

export const RELEVANCE: FieldOption = { field: "relevance", label: "Best match", kind: "str", sortable: true };

export const TRASH_SORT_IS_CLIENT_SIDE = false;

export function buildFilter(draft: FilterDraft, context: ConditionContext = {}): FilterJson | undefined {
  return buildConditions(draft, context);
}

export function buildEffectiveFilter(draft: FilterDraft, context: ConditionContext = {}): FilterJson | undefined {
  const filter = buildFilter(draft, context);
  return draft.includeMachine === true ? filter : withoutMachineDocuments(filter);
}

export function invalidClauses(draft: FilterDraft): readonly string[] {
  return draft.clauses.filter((clause) => clauseProblem(clause) !== undefined).map((clause) => clause.id);
}

export function appliedCount(draft: FilterDraft): number {
  const usable = draft.clauses.filter((clause) => clauseProblem(clause) === undefined).length;
  return usable + (draft.includeMachine === true ? 1 : 0);
}

export const TRASHED_ONLY: FilterJson = { cmp: { field: "deleted", op: "eq", value: { bool: true } } };

export function buildSort(field: string, direction: "asc" | "desc"): readonly SortKey[] {
  return [{ field, direction }];
}
