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
 * - **An incomplete clause is marked, not dropped in silence.** A half-typed date or an
 *   empty value produces no clause, and the row says so — otherwise the list quietly
 *   ignores what the user just typed.
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
  buildEffectiveFilter,
  describeClause,
  invalidClauses,
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
  const invalid = new Set(invalidClauses(draft));
  // The *effective* filter — what the list actually runs, machine-document exclusion
  // included. Showing the user's clauses alone would make the disclosure a half-truth
  // about the query, which is the one thing this control is for.
  const filter = buildEffectiveFilter(draft);

  const compact = useCompact();
  const panelId = useId();
  const [expanded, setExpanded] = useState(!compact);
  const applied =
    draft.clauses.length - invalid.size + ((draft.titleContains ?? "") !== "" ? 1 : 0);

  const patch = (id: string, change: Partial<FilterClause>): void => {
    onDraftChange({
      ...draft,
      clauses: draft.clauses.map((clause) => (clause.id === id ? { ...clause, ...change } : clause)),
    });
  };

  return (
    <div className="doclist-controls">
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
          className="doclist-filter-toggle"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
        >
          Filters
          {applied > 0 && <span className="doclist-filter-count">{applied}</span>}
        </button>
      </div>

      <div className="doclist-filter-panel" id={panelId} hidden={!expanded}>
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

          <ul className="doclist-clauses">
            {draft.clauses.map((clause) => {
              const valueless = VALUELESS_OPS.includes(clause.op);
              return (
                <li
                  key={clause.id}
                  className={`doclist-clause${invalid.has(clause.id) ? " doclist-clause-invalid" : ""}`}
                >
                  <label className="doclist-field">
                    <span className="doclist-visually-hidden">Field</span>
                    <input
                      list="doclist-fields"
                      value={clause.field}
                      placeholder="Property name"
                      onChange={(event) => patch(clause.id, { field: event.target.value })}
                    />
                  </label>

                  <label className="doclist-field">
                    <span className="doclist-visually-hidden">Operator</span>
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
                        <span className="doclist-visually-hidden">Value type</span>
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
                        <span className="doclist-visually-hidden">Value</span>
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
                    className="doclist-icon-button"
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

                  {invalid.has(clause.id) && (
                    <p className="doclist-clause-note">Incomplete. This condition is ignored.</p>
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
            onClick={() => onDraftChange({ combine: "and", clauses: [], titleContains: "" })}
          >
            Clear
          </button>
        )}
      </div>

      {filter !== undefined && (
        <details className="doclist-json">
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
