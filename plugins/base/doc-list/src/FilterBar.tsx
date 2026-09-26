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
 * **One toolbar: the search bar, then three icons.** Search runs the providers
 * (`search/`) and turns the list into ranked results; sort opens a `context-menu` of
 * fields ("Best match" joins them while a search is on), direction flips the order, and
 * the funnel unfolds every filter — "Show machine documents" included — with a badge
 * counting those applied. While the filters are open the funnel stays lit in the accent
 * colour, so the button that folds them away is the obvious one.
 *
 * **On a phone the card docks to the bottom of the screen**, where a thumb is, and so
 * the filters unfold *upwards*, over the results. Focusing the search bar there slides
 * the three icons away so the field has the width; they slide back on blur. On a wide
 * screen the bar sits at the top at its full width and nothing moves.
 *
 * **The filters start folded**, on every screen: the list is what the page is for. The
 * funnel's badge counts the conditions applied (its accessible name says it too),
 * so a folded filter is never a silent one.
 */

import { useId, useState } from "react";
import type { ReactElement, RefObject } from "react";

import type { ContextMenuApi } from "../../_shared/context-menu-api.js";

import { useCompact } from "../../_shared/compact.js";
import {
  FIELD_OPTIONS,
  SORT_OPTIONS,
  VALUELESS_OPS,
  RELEVANCE,
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
  /** `context-menu`'s service, for the sort field menu. */
  readonly menu: ContextMenuApi;
  /** The search bar's text. Empty ⇒ the plain list. */
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  /** The search field, so the "Search documents" command can focus it. */
  readonly searchInput?: RefObject<HTMLInputElement>;
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
  menu,
  query,
  onQueryChange,
  searchInput,
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
  const [expanded, setExpanded] = useState(false);
  // Only a phone slides the icons away; a wide toolbar has room for both.
  const [focused, setFocused] = useState(false);
  const tucked = compact && focused;
  const applied = appliedCount(draft);

  const patch = (id: string, change: Partial<FilterClause>): void => {
    onDraftChange({
      ...draft,
      clauses: draft.clauses.map((clause) => (clause.id === id ? { ...clause, ...change } : clause)),
    });
  };

  return (
    <>
    {compact && expanded && (
      // A dim over everything but the docked card while its filters are open; a tap on
      // it folds them. Only on a phone, where the panel sits over the results.
      <div
        aria-hidden="true"
        className="doclist-filter-scrim doclist:fixed doclist:inset-0 doclist:z-[9] doclist:bg-black/30 doclist:transition-opacity doclist:duration-150 doclist:starting:opacity-0 doclist:motion-reduce:transition-none"
        onClick={() => setExpanded(false)}
      />
    )}
    <div className="doclist-controls doclist:flex doclist:flex-col doclist:compact:sticky doclist:compact:bottom-0 doclist:compact:z-10 doclist:compact:order-last doclist:compact:mt-auto doclist:compact:-mx-2 doclist:compact:-mb-2 doclist:compact:flex-col-reverse doclist:compact:rounded-none doclist:compact:border-x-0 doclist:compact:border-b-0 doclist:compact:border-border-strong doclist:compact:pb-[calc(0.5rem+var(--lm-safe-bottom))] doclist:compact:shadow-2 doclist:gap-2 doclist:rounded doclist:border doclist:border-border doclist:bg-bg-subtle doclist:p-2 doclist:[&_.doclist-checkbox]:tap-h doclist:[&_.doclist-checkbox]:inline-flex doclist:[&_.doclist-checkbox]:cursor-pointer doclist:[&_.doclist-checkbox]:items-center doclist:[&_.doclist-checkbox]:gap-1 doclist:[&_.doclist-checkbox]:whitespace-nowrap doclist:[&_.doclist-clause]:flex doclist:[&_.doclist-clause]:flex-wrap doclist:[&_.doclist-clause]:items-end doclist:[&_.doclist-clause]:gap-1.5 doclist:[&_.doclist-clause]:rounded doclist:[&_.doclist-clause]:border doclist:[&_.doclist-clause]:border-transparent doclist:[&_.doclist-clause]:p-1 doclist:[&_.doclist-clause-invalid]:border-warning doclist:[&_.doclist-field]:flex doclist:[&_.doclist-field]:flex-col doclist:[&_.doclist-field]:gap-0.5 doclist:[&_.doclist-field]:text-sm doclist:[&_.doclist-field]:text-text-muted doclist:[&_.doclist-field_input]:tap-h doclist:[&_.doclist-field_input]:rounded doclist:[&_.doclist-field_input]:border doclist:[&_.doclist-field_input]:border-border doclist:[&_.doclist-field_input]:bg-bg doclist:[&_.doclist-field_input]:px-2 doclist:[&_.doclist-field_input]:text-base doclist:[&_.doclist-field_input]:text-text doclist:[&_.doclist-field_select]:tap-h doclist:[&_.doclist-field_select]:rounded doclist:[&_.doclist-field_select]:border doclist:[&_.doclist-field_select]:border-border doclist:[&_.doclist-field_select]:bg-bg doclist:[&_.doclist-field_select]:px-2 doclist:[&_.doclist-field_select]:text-base doclist:[&_.doclist-field_select]:text-text doclist:[&_.doclist-grow]:flex-[1_1_12rem] doclist:compact:[&_.doclist-grow]:basis-full doclist:[&_.doclist-row]:flex doclist:[&_.doclist-row]:flex-wrap doclist:[&_.doclist-row]:items-end doclist:[&_.doclist-row]:gap-2 doclist:[&_.doclist-sort]:compact:flex-[1_1_8rem] doclist:compact:[&_.doclist-sort_select]:w-full">
      <div className="doclist-toolbar doclist:flex doclist:items-center">
        <SearchField
          query={query}
          onQueryChange={onQueryChange}
          input={searchInput}
          onFocusChange={setFocused}
        />
        <div
          className={`doclist-toolbar-icons doclist:flex doclist:shrink-0 doclist:gap-2 doclist:overflow-hidden doclist:-my-0.5 doclist:py-0.5 doclist:transition-[max-width,margin,padding,opacity] doclist:duration-200 doclist:ease-out doclist:motion-reduce:transition-none ${tucked ? "doclist:ml-0 doclist:max-w-0 doclist:px-0 doclist:opacity-0" : "doclist:ml-1 doclist:max-w-[12rem] doclist:px-0.5 doclist:opacity-100"}`}
          // Tucked away under a focused search on a phone: out of the tab order and the
          // accessibility tree too, not just out of sight.
          {...(tucked ? { inert: "" } : {})}
        >
        <SortControls
          field={sortField}
          direction={sortDirection}
          onChange={onSortChange}
          menu={menu}
          searching={query.trim() !== ""}
        />

        <button
          type="button"
          className={`doclist-filter-toggle ${ICON_BUTTON} doclist:relative doclist:aria-expanded:border-accent! doclist:aria-expanded:bg-accent-subtle! doclist:aria-expanded:text-accent!`}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={applied > 0 ? `Filters, ${applied} applied` : "Filters"}
          title="Filters"
          onClick={() => setExpanded((value) => !value)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="doclist:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
          </svg>
          {applied > 0 && (
            <span
              aria-hidden="true"
              className="doclist-filter-count doclist:absolute doclist:-right-1 doclist:-top-1 doclist:min-w-[1.25em] doclist:rounded-full doclist:bg-accent doclist:px-0.5 doclist:text-center doclist:text-xs doclist:leading-[1.25em] doclist:text-accent-text doclist:tabular-nums"
            >
              {applied}
            </span>
          )}
        </button>
        </div>
      </div>

      {/* Below the toolbar on a wide screen; above it, over the results, on a phone. */}
      <div className={`doclist-filter-panel ${expanded ? "doclist:flex" : "doclist:hidden"} doclist:flex-col doclist:gap-2 doclist:border-t doclist:border-border doclist:pt-2 doclist:compact:max-h-[60dvh] doclist:compact:overflow-y-auto doclist:compact:overscroll-contain doclist:compact:border-t-0 doclist:compact:border-b doclist:compact:pt-0 doclist:compact:pb-2`} id={panelId}>
      <div className="doclist-row">
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
        {(draft.clauses.length > 0 || draft.includeMachine === true) && (
          <button
            type="button"
            // Every filter, "Show machine documents" included: it is one of them.
            onClick={() =>
              onDraftChange({
                ...draft,
                combine: "and",
                clauses: [],
                includeMachine: false,
              })
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
    </>
  );
}

const ICON_BUTTON =
  "doclist:inline-flex doclist:w-[var(--lm-tap-target)] doclist:items-center doclist:justify-center doclist:p-0!";

function SortControls({
  field,
  direction,
  onChange,
  menu,
  searching,
}: {
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly onChange: (field: string, direction: "asc" | "desc") => void;
  readonly menu: ContextMenuApi;
  /** A search is on, so "Best match" is a sort. */
  readonly searching: boolean;
}): ReactElement {
  const options = searching ? [RELEVANCE, ...SORT_OPTIONS] : SORT_OPTIONS;
  const current = options.find((option) => option.field === field) ?? SORT_OPTIONS[0];
  const [desc, asc] =
    current === RELEVANCE
      ? ["best match first", "best match last"]
      : current?.kind === "date"
        ? ["newest first", "oldest first"]
        : ["Z to A", "A to Z"];
  const words = direction === "desc" ? desc : asc;
  const flipped = direction === "desc" ? asc : desc;

  return (
    <>
      <button
        type="button"
        className={`doclist-sort-button ${ICON_BUTTON}`}
        aria-haspopup="menu"
        aria-label={`Sort by ${current?.label ?? field}`}
        title={`Sort by ${current?.label ?? field}`}
        onClick={(event) =>
          menu.open({
            title: "Sort by",
            anchor: event.currentTarget,
            sections: [
              {
                title: "Sort by",
                items: options.map((option) => ({
                  id: option.field,
                  label: option.label,
                  checked: option.field === field,
                  run: () => onChange(option.field, direction),
                })),
              },
            ],
          })
        }
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="doclist:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6h16M7 12h10M10 18h4" />
        </svg>
      </button>
      <button
        type="button"
        className={`doclist-direction-button ${ICON_BUTTON}`}
        aria-label={`Order: ${words}. Switch to ${flipped}`}
        title={`Order: ${words}`}
        onClick={() => onChange(field, direction === "desc" ? "asc" : "desc")}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="doclist:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {direction === "desc" ? (
            <path d="M12 5v14M6 13l6 6 6-6" />
          ) : (
            <path d="M12 19V5M6 11l6-6 6 6" />
          )}
        </svg>
      </button>
    </>
  );
}

/**
 * The search bar. A real `type="search"` field — so a phone's keyboard shows a search
 * key and Escape clears it — with the magnifier drawn inside it rather than beside it.
 */
function SearchField({
  query,
  onQueryChange,
  input,
  onFocusChange,
}: {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly input: RefObject<HTMLInputElement> | undefined;
  readonly onFocusChange: (focused: boolean) => void;
}): ReactElement {
  return (
    <label className="doclist-search doclist:relative doclist:flex doclist:min-w-0 doclist:flex-1 doclist:items-center">
      <span className="doclist:sr-only">Search documents</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="doclist:pointer-events-none doclist:absolute doclist:left-2.5 doclist:size-[1.05em] doclist:text-text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </svg>
      <input
        ref={input}
        className="doclist-search-input doclist:tap-h doclist:w-full doclist:min-w-0 doclist:rounded doclist:border doclist:border-border doclist:bg-bg doclist:py-0 doclist:pl-8 doclist:pr-2 doclist:text-base doclist:text-text"
        type="search"
        value={query}
        spellCheck={false}
        autoComplete="off"
        enterKeyHint="search"
        placeholder="Search documents"
        onChange={(event) => onQueryChange(event.target.value)}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
      />
    </label>
  );
}
