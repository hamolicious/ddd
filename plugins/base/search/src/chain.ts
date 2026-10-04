import { TREE_OPS, clauseProblem, describeClause, type FilterClause } from "../../_shared/conditions.js";
import type { SearchSort } from "./api.js";

import { RELEVANCE, SORT_OPTIONS, type FieldOption, type FilterDraft, type FilterGroup } from "./filter.js";

export const ANY_STEP = "*";

export interface ChainStep {
  readonly id: string;
  readonly verb: "where" | "inside" | "or";
  readonly text: string;
  readonly ready: boolean;
}

export function clauseText(clause: FilterClause, noteTitle: (id: string) => string): string {
  if (clause.op === "child_of") {
    const title = clause.value.trim() === "" ? "…" : noteTitle(clause.value.trim());
    return `${clause.negate === true ? "not " : ""}${title}${clause.deep === true ? " and below" : ""}`;
  }
  if (clause.op === "parent_of") {
    const title = clause.value.trim() === "" ? "…" : noteTitle(clause.value.trim());
    return `${clause.negate === true ? "not " : ""}contains ${title}`;
  }
  return describeClause(clause);
}

function ready(clauses: readonly FilterClause[]): boolean {
  return clauses.length > 0 && clauses.every((clause) => clauseProblem(clause) === undefined);
}

function groupText(group: FilterGroup, noteTitle: (id: string) => string): string {
  const lead = group.negate === true ? "none of" : group.combine === "or" ? "any of" : "all of";
  return `${lead}: ${group.clauses.map((clause) => clauseText(clause, noteTitle)).join(" · ")}`;
}

export function chainSteps(draft: FilterDraft, noteTitle: (id: string) => string): readonly ChainStep[] {
  const groups = draft.groups ?? [];
  if (draft.combine === "or") {
    const head: ChainStep[] =
      draft.clauses.length === 0
        ? []
        : [
            {
              id: ANY_STEP,
              verb: "where",
              text: `any of: ${draft.clauses.map((clause) => clauseText(clause, noteTitle)).join(" · ")}`,
              ready: ready(draft.clauses),
            },
          ];
    return [
      ...head,
      ...groups.map((group, index): ChainStep => ({
        id: group.id,
        verb: head.length > 0 || index > 0 ? "or" : "where",
        text: groupText(group, noteTitle),
        ready: ready(group.clauses),
      })),
    ];
  }
  return [
    ...draft.clauses.map((clause): ChainStep => ({
      id: clause.id,
      verb: TREE_OPS.includes(clause.op) && clause.op === "child_of" ? "inside" : "where",
      text: clauseText(clause, noteTitle),
      ready: ready([clause]),
    })),
    ...groups.map((group): ChainStep => ({ id: group.id, verb: "where", text: groupText(group, noteTitle), ready: ready(group.clauses) })),
  ];
}

export const MATCH_SCORE: FieldOption = { field: "score", label: "Match score", kind: "float", sortable: true };

export function sortOptions(
  searching: boolean,
  sort: SearchSort,
  extra: readonly FieldOption[],
  fuzzy = false,
): readonly FieldOption[] {
  const options = [...(fuzzy ? [MATCH_SCORE] : []), ...(searching ? [RELEVANCE] : []), ...SORT_OPTIONS, ...extra];
  return options.some((option) => option.field === sort.field)
    ? options
    : [...options, { field: sort.field, label: sort.field.replace(/^fm\./, ""), kind: "str", sortable: true }];
}

export function orderWords(option: FieldOption | undefined): { readonly desc: string; readonly asc: string } {
  if (option?.field === RELEVANCE.field || option?.field === MATCH_SCORE.field) return { desc: "best match first", asc: "best match last" };
  if (option?.kind === "date") return { desc: "newest first", asc: "oldest first" };
  return { desc: "Z to A", asc: "A to Z" };
}

export function sortText(sort: SearchSort, options: readonly FieldOption[]): string {
  const option = options.find((entry) => entry.field === sort.field);
  const words = orderWords(option);
  return `${option?.label ?? sort.field}, ${sort.direction === "desc" ? words.desc : words.asc}`;
}
