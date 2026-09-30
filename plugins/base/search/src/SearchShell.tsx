/**
 * `SearchShell` — a search, shown: the controls (`FilterBar.tsx`) over the host's view,
 * fed by `useResults`. The all-documents page, a saved-search note and an embed of one are
 * all this component with different `controls`.
 *
 * - **`shown`**: the toolbar, as the all-documents page has it.
 * - **`folded`**: an "Edit search" button unfolds it — a saved search, whose search is
 *   already decided.
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
import type { SearchField, SearchShellProps, SearchSort, SearchSpec, SearchViewProps } from "./api.js";

import { indexNoteSource, indexSuggestions, type ConditionIndex } from "../../_shared/conditions-index.js";
import { useConditionContext } from "../../_shared/conditions-children.js";
import { treeToWatch } from "../../_shared/conditions.js";
import { documentsNoteSource } from "../../_shared/note-picker.js";

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
  readonly index: () => ConditionIndex | undefined;
  /** The Actions menu over these ids, when a commands registry is wired. */
  readonly actions: () => ((ids: readonly string[], anchor: HTMLElement) => void) | undefined;
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
        className="search-page search:flex search:flex-col search:gap-3 search:p-4 search:font-sans search:text-text search:compact:min-h-full search:compact:p-2 search:[&_:focus-visible]:outline-2 search:[&_:focus-visible]:outline-offset-1 search:[&_:focus-visible]:outline-focus search:[&_button]:tap-h search:[&_button]:cursor-pointer search:[&_button]:rounded search:[&_button]:border search:[&_button]:border-border search:[&_button]:bg-bg-subtle search:[&_button]:px-2 search:[&_button]:text-inherit search:disabled:[&_button]:cursor-default search:disabled:[&_button]:opacity-55"
        {...(heading !== undefined ? { "aria-label": heading } : { "aria-label": "Search results" })}
      >
        {heading !== undefined && (
          <header className="search:flex search:items-center search:justify-between search:gap-2 search:[&_h2]:m-0">
            <h2>{heading}</h2>
          </header>
        )}

        {controls === "folded" && (
          <div className="search-edit search:flex search:items-center search:justify-end search:gap-2 search:text-sm">
            {!searchOpen && onSave && (
              <button type="button" onClick={onSave}>
                {saveLabel ?? "Save search"}
              </button>
            )}
            <button type="button" aria-expanded={searchOpen} onClick={() => setSearchOpen((value) => !value)}>
              {searchOpen ? "Hide search" : "Edit search"}
            </button>
          </div>
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

        {results.rows.length === 0 && showsEmpty === true ? (
          // A view whose frame means something with nothing in it: a board's columns.
          renderView(viewProps)
        ) : results.loading && results.rows.length === 0 ? (
          <p className="search-empty search:m-0 search:py-6 search:text-text-muted" role="status">
            {searching ? "Searching…" : "Loading…"}
          </p>
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
            <p className="search-status search:m-0 search:text-sm search:text-text-muted" role="status" aria-live="polite">
              {statusText(results.rows.length, results.total, results.hasMore, text)}
            </p>
          </>
        )}
      </section>
    );
  };
}

/** The line under the results: the real total when it is known, else what was found. */
function statusText(shown: number, total: number | undefined, more: boolean, text: string): string {
  if (total !== undefined) return `${total.toLocaleString()} document${total === 1 ? "" : "s"}`;
  const count = `${shown.toLocaleString()}${more ? "+" : ""}`;
  return `${count} result${shown === 1 && !more ? "" : "s"}${text === "" ? "" : ` for “${text}”`}`;
}
