/**
 * `SearchShell` — a search, shown: the controls (`FilterBar.tsx`) over the host's view,
 * fed by `useResults`. The all-documents page, a saved-search note and an embed of one are
 * all this component with different `controls`.
 *
 * - **`shown`**: the toolbar, as the all-documents page has it.
 * - **`folded`**: a cog over the top right of the results unfolds it — a saved search,
 *   whose search is already decided. The cog is `icons`' (an optional dependency; a ⚙
 *   without it), and "Update saved search" sits beside it when the search was changed.
 * - **`hidden`**: the results alone — an embed. A header click still sorts, on screen
 *   only: the reader is reading another note, not editing this one.
 *
 * **The view is the host's.** A view plugin passes `renderView`, and its settings as
 * `renderSettings` for the View panel; the shell knows nothing of either. The host's own
 * `document.mode` is already inside the kernel's error boundary.
 *
 * **Acting on results** — the Actions button, which hands every loaded row's id to the
 * commands that `takes: "documents"` — is the shell's, so every view gets it without
 * re-implementing it. A single result's menu is `context-menu`'s: a view marks each result
 * as an `lm/document` (`_shared/target.ts`).
 */

import { useMemo, useState } from "react";
import type { ComponentType, ReactElement } from "react";

import type { Kernel } from "@kernel";
import type { ContextMenu } from "plugin:context-menu";
import type { Icons } from "plugin:icons";
import type { FmKeySelectProps, FmValueSelectProps, NoteSelectProps, SearchField, SearchShellProps, SearchSort, SearchSpec, SearchViewProps } from "./api.js";

import { indexNoteSource, indexSuggestions, type ConditionIndex } from "../../_shared/conditions-index.js";
import { useConditionContext } from "../../_shared/conditions-children.js";
import { treeToWatch } from "../../_shared/conditions.js";
import { documentsNoteSource } from "../../_shared/note-picker.js";
import { Spinner } from "../../_shared/Spinner.js";

import { FilterBar } from "./FilterBar.js";
import { RELEVANCE, SORT_OPTIONS, type FieldOption } from "./filter.js";
import { useReportRendered, useResults } from "./results.js";
import { effectiveSort, filterOf } from "./spec.js";
import type { SearchEngine } from "./useSearch.js";

export interface SearchShellDeps {
  readonly kernel: Kernel;
  readonly engine: SearchEngine;
  /** `context-menu`'s `open`: the sort menu. */
  readonly menu: Pick<ContextMenu, "open">;
  /** `icons`, when it is there: the cog that unfolds a saved search's controls. */
  readonly icons: () => Pick<Icons, "Icon"> | undefined;
  readonly index: () => ConditionIndex | undefined;
  /** The Actions menu over these ids, when a commands registry is wired. */
  readonly actions: () => ((ids: readonly string[], anchor: HTMLElement) => void) | undefined;
  /** Picks the note for "is inside note" and the like. */
  readonly NoteSelect: ComponentType<NoteSelectProps>;
  /** The property box, and the value box, of a condition. */
  readonly FmKeySelect: ComponentType<FmKeySelectProps>;
  readonly FmValueSelect: ComponentType<FmValueSelectProps>;
}

export function createSearchShell(deps: SearchShellDeps): ComponentType<SearchShellProps> {
  const { kernel, engine, menu } = deps;

  return function SearchShell({
    spec,
    onSpecChange,
    controls = "shown",
    heading,
    onOpen,
    onSave,
    saveLabel,
    searchInput,
    onRendered,
    renderView,
    renderSettings,
    pageSize,
    showsEmpty,
  }: SearchShellProps): ReactElement {
    const [searchOpen, setSearchOpen] = useState(controls === "shown");
    // An embed sorts on screen only.
    const [localSort, setLocalSort] = useState<SearchSort | undefined>(undefined);
    const shownSpec: SearchSpec = controls === "hidden" && localSort ? { ...spec, sort: localSort } : spec;

    const results = useResults(kernel.documents, engine, shownSpec, pageSize === undefined ? {} : { pageSize });
    useReportRendered(results.rows, onRendered);

    const draft = filterOf(spec);
    const text = spec.query.trim();
    const searching = text !== "";
    const sort = effectiveSort(shownSpec);
    const index = deps.index();
    const context = useConditionContext(kernel.documents, treeToWatch(draft));
    const notes = useMemo(
      () => (index !== undefined ? indexNoteSource(index) : documentsNoteSource(kernel.documents)),
      [index],
    );
    const suggestions = useMemo(() => (index !== undefined ? indexSuggestions(index) : undefined), [index]);

    const setSort = (next: SearchSort): void => {
      if (controls === "hidden") setLocalSort(next);
      else onSpecChange({ ...spec, sort: next });
    };

    // The sort in force, offered in the sort menu when it is not one of the fixed ones
    // (a column header picked it).
    const known = [RELEVANCE, ...SORT_OPTIONS].some((option) => option.field === sort.field);
    const extraSorts: readonly FieldOption[] = known
      ? []
      : [{ field: sort.field, label: sort.field.replace(/^fm\./, ""), kind: "str", sortable: true }];

    const fields: readonly SearchField[] = (suggestions?.fields() ?? []).map((option) => ({
      field: option.field,
      label: option.label,
      ...(option.kind !== undefined ? { kind: option.kind } : {}),
    }));
    const viewPanel = renderSettings?.(fields);

    const actions = deps.actions();
    const narrowed = searching || !results.unfiltered;
    const viewProps: SearchViewProps = {
      spec: shownSpec,
      results,
      sort,
      onSortChange: setSort,
      onOpen,
      embedded: controls === "hidden",
      editing: controls !== "hidden" && searchOpen,
    };

    return (
      <section
        // Embedded, the note around it already frames it: no padding of its own.
        className={`search-page search:flex search:flex-col search:font-sans search:text-text ${controls === "hidden" ? "search:gap-2" : "search:gap-3 search:p-4 search:compact:min-h-full search:compact:p-2"} search:[&_:focus-visible]:outline-2 search:[&_:focus-visible]:outline-offset-1 search:[&_:focus-visible]:outline-focus search:[&_button]:tap-h search:[&_button]:cursor-pointer search:[&_button]:rounded search:[&_button]:border search:[&_button]:border-border search:[&_button]:bg-bg-subtle search:[&_button]:px-2 search:[&_button]:text-inherit search:disabled:[&_button]:cursor-default search:disabled:[&_button]:opacity-55`}
        {...(heading !== undefined ? { "aria-label": heading } : { "aria-label": "Search results" })}
      >
        {heading !== undefined && (
          <header className="search:flex search:items-center search:justify-between search:gap-2 search:[&_h2]:m-0">
            <h2>{heading}</h2>
          </header>
        )}

        {controls !== "hidden" && searchOpen && (
          <FilterBar
            menu={menu}
            draft={draft}
            onDraftChange={(filter) => onSpecChange({ ...spec, filter })}
            sortField={sort.field}
            sortDirection={sort.direction}
            onSortChange={(field, direction) => setSort({ field, direction })}
            query={spec.query}
            onQueryChange={(query) => onSpecChange({ ...spec, query })}
            {...(viewPanel !== undefined ? { viewPanel } : {})}
            extraSorts={extraSorts}
            {...(searchInput ? { searchInput } : {})}
            notes={notes}
            NoteSelect={deps.NoteSelect}
            FmKeySelect={deps.FmKeySelect}
            FmValueSelect={deps.FmValueSelect}
            {...(suggestions !== undefined ? { suggestions } : {})}
            context={context}
            {...(onSave ? { onSave } : {})}
            {...(saveLabel !== undefined ? { saveLabel } : {})}
            {...(actions && narrowed && results.rows.length > 0
              ? { onActions: (anchor: HTMLElement) => actions(results.rows.map((row) => row.id), anchor) }
              : {})}
          />
        )}

        {results.partial && (
          <p className="search:m-0 search:text-sm search:text-text-muted" role="status">
            Some results need a connection. These come from this device.
          </p>
        )}
        {results.error && (
          <p className="search:m-0 search:rounded search:border search:border-danger search:p-2" role="alert">
            {results.error}
          </p>
        )}

        <div className={`search-results search:relative search:flex search:flex-col ${controls === "hidden" ? "search:gap-2" : "search:gap-3"}`}>
        {controls === "folded" && (
          <SearchCog
            open={searchOpen}
            onToggle={() => setSearchOpen((value) => !value)}
            Icon={deps.icons()?.Icon}
            {...(!searchOpen && onSave ? { onSave, saveLabel: saveLabel ?? "Save search" } : {})}
          />
        )}
        <Busy on={results.loading} label={searching ? "Searching" : "Loading"} beside={controls === "folded"} />
        {results.rows.length === 0 && showsEmpty === true ? (
          // A view whose frame means something with nothing in it: a board's columns.
          renderView(viewProps)
        ) : results.loading && results.rows.length === 0 ? (
          // The first answer is on its way: room for it, and the spinner says why.
          <div className="search-empty search:min-h-16" />
        ) : results.rows.length === 0 ? (
          <p className="search-empty search:m-0 search:py-6 search:text-text-muted">
            {searching
              ? `Nothing matches “${text}”.`
              : results.unfiltered
                ? "No documents yet."
                : "No document matches. Clear the filter."}
          </p>
        ) : (
          <>
            {renderView(viewProps)}
            {/* Embedded, the count is noise unless it says the view is cut short. */}
            {(controls !== "hidden" || results.hasMore) && (
              <p className="search-status search:m-0 search:text-sm search:text-text-muted" role="status" aria-live="polite">
                {statusText(results.rows.length, results.total, results.hasMore, text)}
              </p>
            )}
          </>
        )}
        </div>
      </section>
    );
  };
}

/**
 * A spinner at the top right of the results while they load. It fades in only after a
 * moment, so a search that answers at once never flashes it, and fades out when done.
 * Absolutely placed, so it never moves anything; the live region carries the words.
 */
function Busy({ on, label, beside = false }: { readonly on: boolean; readonly label: string; readonly beside?: boolean }): ReactElement {
  return (
    <div
      className={`search-busy search:pointer-events-none search:absolute search:top-[3px] search:z-10 ${beside ? "search:right-11" : "search:right-2"} search:flex search:size-5 search:items-center search:justify-center search:rounded-full search:bg-bg-raised search:opacity-0 search:shadow-1 search:transition-opacity search:duration-200 search:data-[on]:opacity-100 search:data-[on]:delay-150`}
      data-on={on ? "" : undefined}
    >
      <Spinner label={on ? `${label}…` : ""} />
    </div>
  );
}

/** The line under the results: the real total when it is known, else what was found. */
function statusText(shown: number, total: number | undefined, more: boolean, text: string): string {
  if (total !== undefined) return `${total.toLocaleString()} document${total === 1 ? "" : "s"}`;
  const count = `${shown.toLocaleString()}${more ? "+" : ""}`;
  return `${count} result${shown === 1 && !more ? "" : "s"}${text === "" ? "" : ` for “${text}”`}`;
}

/**
 * A saved search's controls, folded behind a cog over the top right of the results: a
 * round, raised button, in the accent while the controls are open. "Update saved search"
 * (or "Save search") sits beside it while the search differs from what the note holds.
 */
function SearchCog({
  open,
  onToggle,
  Icon,
  onSave,
  saveLabel,
}: {
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly Icon: ComponentType<{ readonly name: string; readonly size?: number | string }> | undefined;
  readonly onSave?: () => void;
  readonly saveLabel?: string;
}): ReactElement {
  return (
    <div className="search-cog search:absolute search:right-0 search:top-0 search:z-10 search:flex search:items-center search:gap-1.5">
      {onSave && (
        <button
          type="button"
          className="search:h-8! search:min-h-0! search:rounded-full! search:border-accent! search:bg-accent! search:px-3! search:text-xs search:font-medium search:text-accent-text! search:shadow-1 search:transition-colors search:duration-150 search:hover:opacity-90"
          onClick={onSave}
        >
          {saveLabel}
        </button>
      )}
      <button
        type="button"
        className={`search:inline-flex search:size-8! search:min-h-0! search:min-w-0! search:items-center search:justify-center search:rounded-full! search:p-0! search:text-base search:shadow-1 search:transition-colors search:duration-150 ${
          open
            ? "search:border-accent! search:bg-accent-subtle! search:text-text"
            : "search:border-border! search:bg-bg-raised! search:text-text-muted search:hover:border-border-strong! search:hover:text-text"
        }`}
        aria-expanded={open}
        aria-label={open ? "Hide search" : "Edit search"}
        title={open ? "Hide search" : "Edit search"}
        onClick={onToggle}
      >
        {Icon ? <Icon name="settings" size="1.1em" /> : <span aria-hidden="true">⚙</span>}
      </button>
    </div>
  );
}
