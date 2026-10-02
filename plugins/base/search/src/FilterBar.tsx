import { useId, useState } from "react";
import type { ComponentType, ReactElement, ReactNode, RefObject } from "react";

import type { ContextMenu } from "plugin:context-menu";

import { useCompact } from "../../_shared/compact.js";
import type { ConditionContext } from "../../_shared/conditions.js";
import { ConditionsEditor, type FmKeySelectLike, type FmValueSelectLike, type NoteSelectLike } from "../../_shared/conditions-editor.js";
import type { NoteSource } from "../../_shared/note-picker.js";
import type { Suggestions } from "../../_shared/conditions-index.js";
import {
  SORT_OPTIONS,
  RELEVANCE,
  appliedCount,
  buildEffectiveFilter,
  type FieldOption,
  type FilterDraft,
} from "./filter.js";

export interface FilterBarProps {
  readonly draft: FilterDraft;
  readonly onDraftChange: (draft: FilterDraft) => void;
  readonly sortField: string;
  readonly sortDirection: "asc" | "desc";
  readonly onSortChange: (field: string, direction: "asc" | "desc") => void;
  readonly menu: Pick<ContextMenu, "open">;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly viewPanel?: ReactNode;
  readonly extraSorts?: readonly FieldOption[];
  readonly searchInput?: RefObject<HTMLInputElement>;
  readonly onActions?: (anchor: HTMLElement) => void;
  readonly onSave?: () => void;
  readonly saveLabel?: string;
  readonly notes?: NoteSource;
  readonly NoteSelect?: ComponentType<NoteSelectLike>;
  readonly FmKeySelect?: ComponentType<FmKeySelectLike>;
  readonly FmValueSelect?: ComponentType<FmValueSelectLike>;
  readonly suggestions?: Suggestions;
  readonly context?: ConditionContext;
}

export function FilterBar({
  draft,
  onDraftChange,
  sortField,
  sortDirection,
  onSortChange,
  menu,
  query,
  onQueryChange,
  viewPanel,
  extraSorts = [],
  searchInput,
  onActions,
  onSave,
  saveLabel = "Save search",
  notes,
  NoteSelect,
  FmKeySelect,
  FmValueSelect,
  suggestions,
  context,
}: FilterBarProps): ReactElement {
  const filter = buildEffectiveFilter(draft, context);

  const compact = useCompact();
  const panelId = useId();
  const viewPanelId = useId();
  const [panel, setPanel] = useState<"filters" | "view" | undefined>(undefined);
  const expanded = panel === "filters";
  const setExpanded = (next: boolean | ((value: boolean) => boolean)): void =>
    setPanel((current) => {
      const open = typeof next === "function" ? next(current === "filters") : next;
      return open ? "filters" : current === "filters" ? undefined : current;
    });
  const [focused, setFocused] = useState(false);
  const tucked = compact && focused;
  const applied = appliedCount(draft);

  return (
    <>
    {compact && panel !== undefined && (
      <div
        aria-hidden="true"
        className="search-filter-scrim search:fixed search:inset-0 search:z-[9] search:bg-black/30 search:transition-opacity search:duration-150 search:starting:opacity-0 search:motion-reduce:transition-none"
        onClick={() => setPanel(undefined)}
      />
    )}
    <div className="search-controls search:flex search:flex-col search:compact:sticky search:compact:bottom-0 search:compact:z-10 search:compact:order-last search:compact:mt-auto search:compact:-mx-2 search:compact:-mb-2 search:compact:flex-col-reverse search:compact:rounded-none search:compact:border-x-0 search:compact:border-b-0 search:compact:border-border-strong search:compact:pb-[calc(0.5rem+max(0px,var(--ddd-safe-bottom)-var(--shell-footer-height,0px)))] search:compact:shadow-2 search:gap-2 search:rounded search:border search:border-border search:bg-bg-subtle search:p-2 search:[&_.search-checkbox]:tap-h search:[&_.search-checkbox]:inline-flex search:[&_.search-checkbox]:cursor-pointer search:[&_.search-checkbox]:items-center search:[&_.search-checkbox]:gap-1 search:[&_.search-checkbox]:whitespace-nowrap search:[&_.search-clause]:flex search:[&_.search-clause]:flex-wrap search:[&_.search-clause]:items-end search:[&_.search-clause]:gap-1.5 search:[&_.search-clause]:rounded search:[&_.search-clause]:border search:[&_.search-clause]:border-transparent search:[&_.search-clause]:p-1 search:[&_.search-clause-invalid]:border-warning search:[&_.search-field]:flex search:[&_.search-field]:flex-col search:[&_.search-field]:gap-0.5 search:[&_.search-field]:text-sm search:[&_.search-field]:text-text-muted search:[&_.search-field_input]:tap-h search:[&_.search-field_input]:rounded search:[&_.search-field_input]:border search:[&_.search-field_input]:border-border search:[&_.search-field_input]:bg-bg search:[&_.search-field_input]:px-2 search:[&_.search-field_input]:text-base search:[&_.search-field_input]:text-text search:[&_.search-field_select]:tap-h search:[&_.search-field_select]:rounded search:[&_.search-field_select]:border search:[&_.search-field_select]:border-border search:[&_.search-field_select]:bg-bg search:[&_.search-field_select]:px-2 search:[&_.search-field_select]:text-base search:[&_.search-field_select]:text-text search:[&_.search-grow]:flex-[1_1_12rem] search:compact:[&_.search-grow]:basis-full search:[&_.search-row]:flex search:[&_.search-row]:flex-wrap search:[&_.search-row]:items-end search:[&_.search-row]:gap-2 search:[&_.search-clauses]:m-0 search:[&_.search-clauses]:flex search:[&_.search-clauses]:list-none search:[&_.search-clauses]:flex-col search:[&_.search-clauses]:gap-2 search:[&_.search-clauses]:p-0 search:[&_.search-clause-note]:m-0 search:[&_.search-clause-note]:flex-[1_1_100%] search:[&_.search-clause-note]:text-sm search:[&_.search-clause-note]:text-warning search:[&_.search-icon-button]:min-w-[var(--ddd-tap-target)] search:[&_.search-flags]:flex search:[&_.search-flags]:flex-[1_1_100%] search:[&_.search-flags]:flex-wrap search:[&_.search-flags]:items-center search:[&_.search-flags]:gap-3 search:[&_.search-op-icon]:tap-h search:[&_.search-op-icon]:inline-flex search:[&_.search-op-icon]:min-w-[2ch] search:[&_.search-op-icon]:items-center search:[&_.search-op-icon]:justify-center search:[&_.search-op-icon]:px-1 search:[&_.search-op-icon]:font-mono search:[&_.search-op-icon]:text-text-muted search:[&_.search-op-icon]:whitespace-nowrap search:[&_.search-note-results]:flex search:[&_.search-note-results]:flex-wrap search:[&_.search-note-results]:gap-1 search:[&_.search-sort]:compact:flex-[1_1_8rem] search:compact:[&_.search-sort_select]:w-full">
      <div className="search-toolbar search:flex search:items-center">
        <SearchField
          query={query}
          onQueryChange={onQueryChange}
          input={searchInput}
          onFocusChange={setFocused}
        />
        <div
          className={`search-toolbar-icons search:flex search:shrink-0 search:gap-2 search:overflow-hidden search:-my-0.5 search:py-0.5 search:transition-[max-width,margin,padding,opacity] search:duration-200 search:ease-out search:motion-reduce:transition-none ${tucked ? "search:ml-0 search:max-w-0 search:px-0 search:opacity-0" : "search:ml-1 search:max-w-[22rem] search:px-0.5 search:opacity-100"}`}
          {...(tucked ? { inert: "" } : {})}
        >
        <SortControls
          field={sortField}
          direction={sortDirection}
          onChange={onSortChange}
          menu={menu}
          searching={query.trim() !== ""}
          extra={extraSorts}
        />

        <button
          type="button"
          className={`search-filter-toggle ${ICON_BUTTON} search:relative search:aria-expanded:border-accent! search:aria-expanded:bg-accent-subtle! search:aria-expanded:text-accent!`}
          aria-expanded={expanded}
          aria-controls={panelId}
          aria-label={applied > 0 ? `Filters, ${applied} applied` : "Filters"}
          title="Filters"
          onClick={() => setExpanded((value) => !value)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="search:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
          </svg>
          {applied > 0 && (
            <span
              aria-hidden="true"
              className="search-filter-count search:absolute search:-right-1 search:-top-1 search:min-w-[1.25em] search:rounded-full search:bg-accent search:px-0.5 search:text-center search:text-xs search:leading-[1.25em] search:text-accent-text search:tabular-nums"
            >
              {applied}
            </span>
          )}
        </button>

        {viewPanel !== undefined && (
        <button
          type="button"
          className={`search-view-toggle ${ICON_BUTTON} search:aria-expanded:border-accent! search:aria-expanded:bg-accent-subtle! search:aria-expanded:text-accent!`}
          aria-expanded={panel === "view"}
          aria-controls={viewPanelId}
          aria-label="View"
          title="View"
          onClick={() => setPanel((current) => (current === "view" ? undefined : "view"))}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="search:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 9h18M9 9v11M15 9v11" />
          </svg>
        </button>
        )}

        {onSave && (
          <button
            type="button"
            className={`search-save ${ICON_BUTTON}`}
            aria-label={saveLabel}
            title={saveLabel}
            onClick={onSave}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="search:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 7v14l-6-4-6 4V7a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4z" />
            </svg>
          </button>
        )}

        {onActions && (
          <button
            type="button"
            className={`search-actions ${ICON_BUTTON}`}
            aria-haspopup="menu"
            aria-label="Actions for these results"
            title="Actions"
            onClick={(event) => onActions(event.currentTarget)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="search:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 3v7h6l-8 11v-7H5z" />
            </svg>
          </button>
        )}
        </div>
      </div>

      {panel === "view" && viewPanel !== undefined && (
        <div
          id={viewPanelId}
          className="search-view-panel search:flex search:flex-col search:gap-2 search:border-t search:border-border search:pt-2 search:compact:max-h-[60dvh] search:compact:overflow-y-auto search:compact:border-t-0 search:compact:border-b search:compact:pt-0 search:compact:pb-2"
        >
          {viewPanel}
        </div>
      )}

      <div className={`search-filter-panel ${expanded ? "search:flex" : "search:hidden"} search:flex-col search:gap-2 search:border-t search:border-border search:pt-2 search:compact:max-h-[60dvh] search:compact:overflow-y-auto search:compact:overscroll-contain search:compact:border-t-0 search:compact:border-b search:compact:pt-0 search:compact:pb-2`} id={panelId}>
      <div className="search-row">
        <label className="search-checkbox">
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

      <ConditionsEditor
        value={draft}
        onChange={(conditions) => onDraftChange({ ...draft, ...conditions })}
        classPrefix="search"
        {...(notes !== undefined ? { notes } : {})}
        {...(NoteSelect !== undefined ? { NoteSelect } : {})}
        {...(FmKeySelect !== undefined ? { FmKeySelect } : {})}
        {...(FmValueSelect !== undefined ? { FmValueSelect } : {})}
        {...(suggestions !== undefined ? { suggestions } : {})}
        actions={
          (draft.clauses.length > 0 || draft.includeMachine === true) && (
            <button
              type="button"
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
          )
        }
      />

      {filter !== undefined && (
        <details className="search-json search:text-sm search:text-text-muted search:[&>summary]:flex search:[&>summary]:min-h-[var(--ddd-tap-target)] search:[&>summary]:cursor-pointer search:[&>summary]:items-center search:[&>pre]:mt-1 search:[&>pre]:overflow-x-auto search:[&>pre]:rounded search:[&>pre]:bg-bg search:[&>pre]:p-2 search:[&>pre]:font-mono">
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
  "search:inline-flex search:w-[var(--ddd-tap-target)] search:items-center search:justify-center search:p-0!";

function SortControls({
  field,
  direction,
  onChange,
  menu,
  searching,
  extra,
}: {
  readonly extra: readonly FieldOption[];
  readonly field: string;
  readonly direction: "asc" | "desc";
  readonly onChange: (field: string, direction: "asc" | "desc") => void;
  readonly menu: Pick<ContextMenu, "open">;
  readonly searching: boolean;
}): ReactElement {
  const options = [...(searching ? [RELEVANCE] : []), ...SORT_OPTIONS, ...extra];
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
        className={`search-sort-button ${ICON_BUTTON}`}
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
        <svg aria-hidden="true" viewBox="0 0 24 24" className="search:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6h16M7 12h10M10 18h4" />
        </svg>
      </button>
      <button
        type="button"
        className={`search-direction-button ${ICON_BUTTON}`}
        aria-label={`Order: ${words}. Switch to ${flipped}`}
        title={`Order: ${words}`}
        onClick={() => onChange(field, direction === "desc" ? "asc" : "desc")}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" className="search:size-[1.15em]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
    <label className="search-search search:relative search:flex search:min-w-0 search:flex-1 search:items-center">
      <span className="search:sr-only">Search documents</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="search:pointer-events-none search:absolute search:left-2.5 search:size-[1.05em] search:text-text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </svg>
      <input
        ref={input}
        className="search-search-input search:tap-h search:w-full search:min-w-0 search:rounded search:border search:border-border search:bg-bg search:py-0 search:pl-8 search:pr-2 search:text-base search:text-text"
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

