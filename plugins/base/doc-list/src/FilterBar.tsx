/**
 * The sort and filter controls.
 *
 * It builds the **DSL JSON** (`filter.ts`), never a Mongo query and never a predicate
 * function — which is what makes the same filter usable by the local evaluator, by the
 * server, and by a saved view later on.
 *
 * Two deliberate choices about honesty:
 *
 * - **The generated JSON is visible.** A details/summary shows exactly what the controls
 *   produced. The filter language is documented and small (SPEC §4.2), so showing it is
 *   cheaper than inventing a second vocabulary for describing it, and it is how a user
 *   learns to write one by hand.
 * - **A clause that produces nothing is marked, with the reason.** A half-typed date, an
 *   empty value, a text operator pointed at a date — each produces no clause, and the
 *   row says which it is. The mark and the query come from one function
 *   (`clauseProblem`), so the row cannot claim to be ignored while the query carries it,
 *   or the reverse. That claim was doubted once (`web/MOBILE-AUDIT.md`, Q5) and is now
 *   pinned by `filter.test.ts` rather than argued.
 *
 * **Sort is always on screen; the rest folds away.** Expanded, this bar cost the whole
 * first screen of a phone, so the browse view opened on no documents at all. The
 * disclosure is collapsed by default only on a compact viewport (`_shared/compact.ts`),
 * and the toggle carries the count of conditions currently applied so a folded filter
 * is never a silent one.
 */

import { useId, useState } from "react";
import type { ReactElement } from "react";

import { useCompact } from "../../_shared/compact.js";
import {
  FIELD_OPTIONS,
  SORT_OPTIONS,
  VALUELESS_OPS,
  appliedCount,
  buildEffectiveFilter,
  clauseProblem,
  describeClause,
  type ClauseOp,
  type FilterClause,
  type FilterDraft,
  type ValueKind,
} from "./filter.js";

export interface FilterBarProps {
  readonly draft: FilterDraft;
  readonly onDraftChange: (draft: FilterDraft) => void;
  readonly sortField: string;
  readonly sortDirection: "asc" | "desc";
  readonly onSortChange: (field: string, direction: "asc" | "desc") => void;
}

const OP_LABELS: readonly { readonly op: ClauseOp; readonly label: string }[] = [
  { op: "eq", label: "is" },
  { op: "ne", label: "is not" },
  { op: "text_contains", label: "contains text" },
  { op: "text_starts_with", label: "starts with" },
  { op: "text_ends_with", label: "ends with" },
  { op: "gt", label: "is after / greater than" },
  { op: "gte", label: "is at least" },
  { op: "lt", label: "is before / less than" },
  { op: "lte", label: "is at most" },
  { op: "contains", label: "list contains" },
  { op: "any", label: "any item is" },
  { op: "every", label: "every item is" },
  { op: "exists", label: "exists" },
  { op: "missing", label: "is missing" },
  { op: "is_null", label: "is null" },
];

const KIND_LABELS: readonly { readonly kind: ValueKind; readonly label: string }[] = [
  { kind: "str", label: "text" },
  { kind: "int", label: "whole number" },
  { kind: "float", label: "number" },
  { kind: "bool", label: "true/false" },
  { kind: "date", label: "date" },
  { kind: "null", label: "null" },
];

let clauseCounter = 0;

export function FilterBar({
  draft,
  onDraftChange,
  sortField,
  sortDirection,
  onSortChange,
}: FilterBarProps): ReactElement {
  // Row id → why it produces no clause. One computation, used both to mark the row and
  // to say what is wrong with it, so the mark and the query cannot disagree.
  const problems = new Map(
    draft.clauses
      .map((clause) => [clause.id, clauseProblem(clause)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  // The *effective* filter — what the list actually runs, machine-document exclusion
  // included. Showing the user's clauses alone would make the disclosure a half-truth
  // about the query, which is the one thing this control is for.
  const filter = buildEffectiveFilter(draft);

  const compact = useCompact();
  const panelId = useId();
  const [expanded, setExpanded] = useState(!compact);
  const applied = appliedCount(draft);

  const patch = (id: string, change: Partial<FilterClause>): void => {
    onDraftChange({
      ...draft,
      clauses: draft.clauses.map((clause) => (clause.id === id ? { ...clause, ...change } : clause)),
    });
  };

  return (
    <div className="doclist-controls doclist:flex doclist:flex-col doclist:gap-2 doclist:rounded doclist:border doclist:border-border doclist:bg-bg-subtle doclist:p-2 doclist:[&_.doclist-checkbox]:tap-h doclist:[&_.doclist-checkbox]:inline-flex doclist:[&_.doclist-checkbox]:cursor-pointer doclist:[&_.doclist-checkbox]:items-center doclist:[&_.doclist-checkbox]:gap-1 doclist:[&_.doclist-checkbox]:whitespace-nowrap doclist:[&_.doclist-clause]:flex doclist:[&_.doclist-clause]:flex-wrap doclist:[&_.doclist-clause]:items-end doclist:[&_.doclist-clause]:gap-1.5 doclist:[&_.doclist-clause]:rounded doclist:[&_.doclist-clause]:border doclist:[&_.doclist-clause]:border-transparent doclist:[&_.doclist-clause]:p-1 doclist:[&_.doclist-clause-invalid]:border-warning doclist:[&_.doclist-field]:flex doclist:[&_.doclist-field]:flex-col doclist:[&_.doclist-field]:gap-0.5 doclist:[&_.doclist-field]:text-sm doclist:[&_.doclist-field]:text-text-muted doclist:[&_.doclist-field_input]:tap-h doclist:[&_.doclist-field_input]:rounded doclist:[&_.doclist-field_input]:border doclist:[&_.doclist-field_input]:border-border doclist:[&_.doclist-field_input]:bg-bg doclist:[&_.doclist-field_input]:px-2 doclist:[&_.doclist-field_input]:text-base doclist:[&_.doclist-field_input]:text-text doclist:[&_.doclist-field_select]:tap-h doclist:[&_.doclist-field_select]:rounded doclist:[&_.doclist-field_select]:border doclist:[&_.doclist-field_select]:border-border doclist:[&_.doclist-field_select]:bg-bg doclist:[&_.doclist-field_select]:px-2 doclist:[&_.doclist-field_select]:text-base doclist:[&_.doclist-field_select]:text-text doclist:[&_.doclist-grow]:flex-[1_1_12rem] doclist:compact:[&_.doclist-grow]:basis-full doclist:[&_.doclist-row]:flex doclist:[&_.doclist-row]:flex-wrap doclist:[&_.doclist-row]:items-end doclist:[&_.doclist-row]:gap-2 doclist:[&_.doclist-sort]:compact:flex-[1_1_8rem] doclist:compact:[&_.doclist-sort_select]:w-full">
      <div className="doclist-row">
        <label className="doclist-field doclist-sort">
          <span>Sort by</span>
          <select
            value={sortField}
            onChange={(event) => onSortChange(event.target.value, sortDirection)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.field} value={option.field}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label className="doclist-field doclist-sort">
          <span>Direction</span>
          <select
            value={sortDirection}
            onChange={(event) =>
              onSortChange(sortField, event.target.value === "asc" ? "asc" : "desc")
            }
          >
            <option value="desc">Newest / Z→A</option>
            <option value="asc">Oldest / A→Z</option>
          </select>
        </label>

        <button
          type="button"
          className="doclist-filter-toggle doclist:ml-auto doclist:inline-flex doclist:items-center doclist:gap-1 doclist:aria-expanded:border-border-strong!"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
        >
          Filters
          {applied > 0 && <span className="doclist-filter-count doclist:rounded doclist:bg-accent-subtle doclist:px-1 doclist:text-sm doclist:tabular-nums">{applied}</span>}
        </button>
      </div>

      <div className={`doclist-filter-panel ${expanded ? "doclist:flex" : "doclist:hidden"} doclist:flex-col doclist:gap-2 doclist:border-t doclist:border-border doclist:pt-2`} id={panelId}>
      <div className="doclist-row">
        <label className="doclist-field doclist-grow">
          <span>Title contains</span>
          <input
            type="search"
            value={draft.titleContains ?? ""}
            placeholder="Search titles"
            onChange={(event) => onDraftChange({ ...draft, titleContains: event.target.value })}
          />
        </label>

        <label className="doclist-checkbox">
          <input
            type="checkbox"
            checked={draft.includeMachine === true}
            onChange={(event) =>
              onDraftChange({ ...draft, includeMachine: event.target.checked })
            }
          />
          <span title="Documents plugins keep for themselves.">Show machine documents</span>
        </label>
      </div>

      {draft.clauses.length > 0 && (
        <>
          <div className="doclist-row">
            <label className="doclist-field">
              <span>Match</span>
              <select
                value={draft.combine}
                onChange={(event) =>
                  onDraftChange({ ...draft, combine: event.target.value === "or" ? "or" : "and" })
                }
              >
                <option value="and">all conditions</option>
                <option value="or">any condition</option>
              </select>
            </label>
          </div>

          <ul className="doclist-clauses doclist:m-0 doclist:flex doclist:list-none doclist:flex-col doclist:gap-2 doclist:p-0">
            {draft.clauses.map((clause) => {
              const valueless = VALUELESS_OPS.includes(clause.op);
              return (
                <li
                  key={clause.id}
                  className={`doclist-clause ${problems.has(clause.id) ? " doclist-clause-invalid" : ""}`}
                >
                  <label className="doclist-field">
                    <span className="doclist:sr-only">Field</span>
                    <input
                      list="doclist-fields"
                      value={clause.field}
                      placeholder="Property name"
                      onChange={(event) => patch(clause.id, { field: event.target.value })}
                    />
                  </label>

                  <label className="doclist-field">
                    <span className="doclist:sr-only">Operator</span>
                    <select
                      value={clause.op}
                      onChange={(event) => patch(clause.id, { op: event.target.value as ClauseOp })}
                    >
                      {OP_LABELS.map((entry) => (
                        <option key={entry.op} value={entry.op}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  {!valueless && (
                    <>
                      <label className="doclist-field">
                        <span className="doclist:sr-only">Value type</span>
                        <select
                          value={clause.kind}
                          onChange={(event) =>
                            patch(clause.id, { kind: event.target.value as ValueKind })
                          }
                        >
                          {KIND_LABELS.map((entry) => (
                            <option key={entry.kind} value={entry.kind}>
                              {entry.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="doclist-field doclist-grow">
                        <span className="doclist:sr-only">Value</span>
                        <input
                          value={clause.value}
                          placeholder={clause.kind === "date" ? "2026-09-23" : "Value"}
                          onChange={(event) => patch(clause.id, { value: event.target.value })}
                        />
                      </label>
                    </>
                  )}

                  <label className="doclist-checkbox">
                    <input
                      type="checkbox"
                      checked={clause.negate === true}
                      onChange={(event) => patch(clause.id, { negate: event.target.checked })}
                    />
                    <span>not</span>
                  </label>

                  <button
                    type="button"
                    className="doclist-icon-button doclist:min-w-[var(--lm-tap-target)]"
                    aria-label={`Remove condition: ${describeClause(clause)}`}
                    onClick={() =>
                      onDraftChange({
                        ...draft,
                        clauses: draft.clauses.filter((entry) => entry.id !== clause.id),
                      })
                    }
                  >
                    ✕
                  </button>

                  {problems.has(clause.id) && (
                    // The reason, not a label. "Incomplete" was shown over a row whose
                    // boxes were all full — a text operator against a date value, say —
                    // and told the reader to finish typing something already typed.
                    <p className="doclist-clause-note doclist:m-0 doclist:flex-[1_1_100%] doclist:text-sm doclist:text-warning">
                      Not applied. {problems.get(clause.id)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <datalist id="doclist-fields">
        {FIELD_OPTIONS.map((option) => (
          <option key={option.field} value={option.field}>
            {option.label}
          </option>
        ))}
      </datalist>

      <div className="doclist-row">
        <button
          type="button"
          onClick={() => {
            clauseCounter += 1;
            onDraftChange({
              ...draft,
              clauses: [
                ...draft.clauses,
                { id: `clause-${clauseCounter}`, field: "fm.status", op: "eq", value: "", kind: "str" },
              ],
            });
          }}
        >
          Add condition
        </button>
        {(draft.clauses.length > 0 || (draft.titleContains ?? "") !== "") && (
          <button
            type="button"
            // Conditions only. "Show machine documents" is a view preference, not a
            // condition — it has its own checkbox and no business being reset by a
            // button that does not name it, which is what spreading a fresh literal
            // over the draft used to do.
            onClick={() =>
              onDraftChange({ ...draft, combine: "and", clauses: [], titleContains: "" })
            }
          >
            Clear
          </button>
        )}
      </div>

      {filter !== undefined && (
        <details className="doclist-json doclist:text-sm doclist:text-text-muted doclist:[&>summary]:flex doclist:[&>summary]:min-h-[var(--lm-tap-target)] doclist:[&>summary]:cursor-pointer doclist:[&>summary]:items-center doclist:[&>pre]:mt-1 doclist:[&>pre]:overflow-x-auto doclist:[&>pre]:rounded doclist:[&>pre]:bg-bg doclist:[&>pre]:p-2 doclist:[&>pre]:font-mono">
          {/* A spec section number is a note to whoever builds this, not to whoever
              uses it. What a reader wants to know is what the block below *is*. */}
          <summary>Show the filter as JSON</summary>
          <pre>{JSON.stringify(filter, null, 2)}</pre>
        </details>
      )}
      </div>
    </div>
  );
}
