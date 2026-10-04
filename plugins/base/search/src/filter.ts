import type { FilterJson, SearchCondition } from "@kernel";

import {
  TREE_OPS,
  buildClause,
  buildConditions,
  clauseCondition,
  clauseProblem,
  whereConditions,
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

export interface FilterGroup extends Conditions {
  readonly id: string;
  readonly negate?: boolean;
}

export interface FilterDraft extends Conditions {
  readonly includeMachine?: boolean;
  readonly groups?: readonly FilterGroup[];
}

interface Expression {
  and(...conditions: readonly SearchCondition[]): SearchCondition;
  or(...conditions: readonly SearchCondition[]): SearchCondition;
  not(condition: SearchCondition): SearchCondition;
}

export function groupCondition<W>(expression: W, group: FilterGroup): SearchCondition | undefined {
  const inner = whereConditions(expression, group);
  if (inner === undefined) return undefined;
  return group.negate === true ? (expression as unknown as Expression).not(inner) : inner;
}

export function filterCondition<W>(expression: W, draft: FilterDraft): SearchCondition | undefined {
  const w = expression as unknown as Expression;
  const parts = [
    ...draft.clauses.map((clause) => clauseCondition(expression, clause)),
    ...(draft.groups ?? []).map((group) => groupCondition(expression, group)),
  ].filter((part): part is SearchCondition => part !== undefined);
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return draft.combine === "or" ? w.or(...parts) : w.and(...parts);
}

function usable(conditions: Conditions): boolean {
  return conditions.clauses.some((clause) =>
    TREE_OPS.includes(clause.op) ? clause.value.trim() !== "" : buildClause(clause) !== undefined,
  );
}

export function hasFilter(draft: FilterDraft): boolean {
  return usable(draft) || (draft.groups ?? []).some(usable);
}

export const SORT_OPTIONS: readonly FieldOption[] = [
  { field: "updated_at", label: "Last updated", kind: "date", sortable: true },
  { field: "created_at", label: "Created", kind: "date", sortable: true },
  { field: "title", label: "Title", kind: "str", sortable: true },
  { field: "id", label: "Id", kind: "str", sortable: true },
];

export const RELEVANCE: FieldOption = { field: "relevance", label: "Best match", kind: "str", sortable: true };

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
  const clauses = draft.clauses.filter((clause) => clauseProblem(clause) === undefined).length;
  const groups = (draft.groups ?? []).filter(usable).length;
  return clauses + groups + (draft.includeMachine === true ? 1 : 0);
}

export function stepConditions(draft: FilterDraft, id: string): (Conditions & { readonly negate?: boolean }) | undefined {
  const clause = draft.clauses.find((entry) => entry.id === id);
  if (clause) return { combine: "and", clauses: [clause] };
  return (draft.groups ?? []).find((group) => group.id === id);
}

export function replaceStep(draft: FilterDraft, id: string, next: Conditions & { readonly negate?: boolean }): FilterDraft {
  const groups = draft.groups ?? [];
  const wasClause = draft.clauses.some((clause) => clause.id === id);
  const withGroups = (list: readonly FilterGroup[]): FilterDraft => {
    const { groups: _, ...rest } = draft;
    return list.length > 0 ? { ...rest, groups: list } : rest;
  };
  const only = next.clauses.length === 1 && next.negate !== true ? next.clauses[0] : undefined;
  if (next.clauses.length === 0) {
    return { ...withGroups(groups.filter((group) => group.id !== id)), clauses: draft.clauses.filter((clause) => clause.id !== id) };
  }
  if (only) {
    const clause = { ...only, id };
    return wasClause
      ? { ...draft, clauses: draft.clauses.map((entry) => (entry.id === id ? clause : entry)) }
      : { ...withGroups(groups.filter((group) => group.id !== id)), clauses: [...draft.clauses, clause] };
  }
  const group: FilterGroup = { id, combine: next.combine, clauses: next.clauses, ...(next.negate === true ? { negate: true } : {}) };
  return wasClause
    ? { ...withGroups([...groups, group]), clauses: draft.clauses.filter((clause) => clause.id !== id) }
    : withGroups(groups.map((entry) => (entry.id === id ? group : entry)));
}
