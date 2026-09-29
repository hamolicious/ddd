/**
 * The document list's filter: the shared conditions (`_shared/conditions.ts`, which
 * holds the DSL rules) plus what only a list has — sorting, the Trash partition, and the
 * machine-document switch.
 */

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
  /**
   * Show machine-owned documents — the ones marked `machine: true`, such as the
   * kernel's per-user settings documents (`_shared/machine-docs.ts`).
   *
   * Off by default, because a workspace of eleven notes reading "12 documents" is
   * wrong about the only question the number answers. It is a **view** default and
   * nothing more: the documents are ordinary documents, and every link to one keeps
   * working whether this is on or off.
   */
  readonly includeMachine?: boolean;
}

/** Sort keys the *server* accepts, for the sort control. `id` is the tiebreaker. */
export const SORT_OPTIONS: readonly FieldOption[] = [
  { field: "updated_at", label: "Last updated", kind: "date", sortable: true },
  { field: "created_at", label: "Created", kind: "date", sortable: true },
  { field: "title", label: "Title", kind: "str", sortable: true },
  { field: "id", label: "Id", kind: "str", sortable: true },
];

/**
 * "Best match": the search providers' ranking, offered only while a search is on and
 * chosen automatically when one starts. Not a field — no query sorts on it; the list
 * reorders its rows by rank (`DocListView`).
 */
export const RELEVANCE: FieldOption = { field: "relevance", label: "Best match", kind: "str", sortable: true };

/**
 * `deleted_at` is not in {@link SORT_OPTIONS} because the main list never shows a
 * tombstone — but it **is** a sort key now, and the Trash view uses it.
 *
 * It used to be neither: `resolve_field` returned `Missing` for that root and
 * `?sort=deleted_at` was a 400, so Trash ordered its rows in the component after the
 * query, over whatever page came back. The shared core's field space reaches it now
 * (`core::filter::ast::FIXED_ROOTS`), so the ordering is the engine's on both sides.
 */
export const TRASH_SORT_IS_CLIENT_SIDE = false;

/** What the user asked for, without the machine-document exclusion. */
export function buildFilter(draft: FilterDraft, context: ConditionContext = {}): FilterJson | undefined {
  return buildConditions(draft, context);
}

/**
 * The filter the list actually runs: {@link buildFilter} plus the machine-document
 * exclusion, unless the draft asks for them.
 *
 * Kept separate from `buildFilter` because the two answer different questions.
 * `buildFilter` is "what did the user ask for", which is what decides whether an empty
 * result says "no documents yet" or "nothing matches your filter"; this is "what goes
 * on the wire". Folding the exclusion into `buildFilter` would make every list look
 * filtered and turn the first-run empty state into the wrong sentence.
 */
export function buildEffectiveFilter(draft: FilterDraft, context: ConditionContext = {}): FilterJson | undefined {
  const filter = buildFilter(draft, context);
  return draft.includeMachine === true ? filter : withoutMachineDocuments(filter);
}

/** Clauses the builder dropped, so the UI can mark the rows instead of losing them silently. */
export function invalidClauses(draft: FilterDraft): readonly string[] {
  return draft.clauses.filter((clause) => clauseProblem(clause) !== undefined).map((clause) => clause.id);
}

/**
 * How many conditions the query actually carries — the number the folded filter bar
 * shows, so a collapsed bar is never a silent one.
 *
 * Counted from {@link buildFilter}'s own rules rather than from the row count: a
 * half-typed row produces no clause, and a badge that counted it would say "1
 * condition applied" over a query with none.
 */
export function appliedCount(draft: FilterDraft): number {
  const usable = draft.clauses.filter((clause) => clauseProblem(clause) === undefined).length;
  return usable + (draft.includeMachine === true ? 1 : 0);
}

/** The filter that selects trashed documents (used with `includeDeleted: true`). */
export const TRASHED_ONLY: FilterJson = { cmp: { field: "deleted", op: "eq", value: { bool: true } } };

/** One sort key. `id` is appended by both engines as the final tiebreaker. */
export function buildSort(field: string, direction: "asc" | "desc"): readonly SortKey[] {
  return [{ field, direction }];
}
