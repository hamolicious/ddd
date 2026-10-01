/**
 * The `search` plugin's API types, and the provider registry. Everything here is exported
 * from `index.tsx` as `plugin:search`.
 *
 * A search is a `SearchSpec` — the text, the filter and the sort — and it travels as one
 * query string (`parse` / `encode`), the same one the list's URL and a saved-search note
 * hold. `useResults` resolves one live.
 *
 * How a search is shown is up to the plugin showing it. `SearchShell` draws the search's
 * controls and hands the results to the host's `renderView`; `SavedSearch` is that shell
 * for a saved-search note, with "Update saved search". A view plugin (a table, a board)
 * adds its own document mode (`document-surface`'s `addMode`) for the saved searches whose
 * `type` names it, and draws itself inside `SavedSearch`. A view marks each result as an
 * `ddd/document` (`_shared/target.ts`) and the row's menu is `context-menu`'s.
 */

import type { ComponentType, ReactNode, RefObject } from "react";

import { createRegistry, s } from "@kernel";
import type { DocumentRow, QueryPlan, SearchHit } from "@kernel";

import type { QueryBuilder, QueryState } from "./query.js";

/**
 * A search source besides the workspace's own — a semantic index, an external wiki —
 * added with `addProvider`. The workspace itself is searched by the query engine, as part
 * of every search's plan. Providers run by `order`, lowest first, and the first one wins
 * ties when results are merged.
 */
export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  /** Lower runs first and wins ties. Default 100. */
  readonly order?: number;
  readonly search: (
    query: string,
    options: { readonly limit?: number; readonly includeDeleted?: boolean },
  ) => Promise<readonly SearchHit[]>;
}

/** Every provider, by `order`; the same `id` replaces the earlier one. */
export const providerRegistry = createRegistry<SearchProvider>({
  key: (provider) => provider.id,
  order: (provider) => provider.order ?? 100,
  shape: s.object({
    id: s.string(),
    label: s.string(),
    order: s.optional(s.number()),
    search: s.func(),
  }),
});

/** One filter row, as the filter editor keeps it. `id` is for React keys and is never stored. */
export interface SearchClause {
  readonly id: string;
  /** A dotted projection path: `title`, `fm.status`. */
  readonly field: string;
  readonly op: string;
  readonly value: string;
  readonly kind: string;
  readonly deep?: boolean;
  readonly negate?: boolean;
}

export interface SearchFilter {
  readonly combine: "and" | "or";
  readonly clauses: readonly SearchClause[];
  /** Include machine-owned documents (`machine: true`), which are left out by default. */
  readonly includeMachine?: boolean;
}

export interface SearchSort {
  /** A field path, or `relevance`: the providers' ranking, while there is text to rank by. */
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export interface SearchSpec {
  readonly query: string;
  readonly filter: SearchFilter;
  /** Absent: best match while searching, else last updated first. */
  readonly sort?: SearchSort;
}

/** The line a result matched on, its terms located in it. */
export interface SearchSnippet {
  readonly text: string;
  /** Offsets into `text` to highlight, ascending. */
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  /** The 1-based line of the document's text it came from. */
  readonly line: number;
}

export interface SearchResults {
  /** The rows loaded so far, in the search's order. */
  readonly rows: readonly DocumentRow[];
  /** Every match, when it is known; absent while there is text to search (providers answer a page at a time). */
  readonly total?: number;
  /** More rows exist than are loaded: call `more`. */
  readonly hasMore: boolean;
  readonly loading: boolean;
  /** A provider another plugin added failed: these rows are the workspace's alone. */
  readonly partial: boolean;
  readonly error?: string;
  /** Load the next page. */
  readonly more: () => void;
  readonly snippetOf: (row: DocumentRow) => SearchSnippet | undefined;
}

/** What a view is handed to draw a search's results. */
export interface SearchViewProps {
  readonly spec: SearchSpec;
  readonly results: SearchResults;
  /** The order the rows are in. */
  readonly sort: SearchSort;
  readonly onSortChange: (sort: SearchSort) => void;
  readonly onOpen: (id: string, line?: number) => void;
  /** Drawn inside another note: no controls for changing the search. */
  readonly embedded: boolean;
  /**
   * The search's controls are open, so the view may show its own controls for changing how
   * it shows the search (a board's column settings). Absent or `false`: for reading.
   */
  readonly editing?: boolean;
}

/** A field a view's settings may offer. */
export interface SearchField {
  /** A field path: `updated_at`, `fm.status`. */
  readonly field: string;
  readonly label: string;
  /** The value family, when one is known: `str`, `date`, `int`, … */
  readonly kind?: string;
}

/** How the host draws the search: its view, its settings, how much to load. */
export interface SearchRender {
  /** The results, drawn. */
  readonly renderView: (props: SearchViewProps) => ReactNode;
  /** The view's own settings, in the search's "View" panel; no panel when absent. */
  readonly renderSettings?: (fields: readonly SearchField[]) => ReactNode;
  /** Rows per page; 50 by default. */
  readonly pageSize?: number;
  /** Draw the view even when nothing matches (a board's columns); otherwise a message says so. */
  readonly showsEmpty?: boolean;
}

export interface SearchShellProps extends SearchRender {
  readonly spec: SearchSpec;
  readonly onSpecChange: (spec: SearchSpec) => void;
  /** `shown` (default); `folded` behind an "Edit search" button; `hidden`, the results alone (an embed). */
  readonly controls?: "shown" | "folded" | "hidden";
  /** A heading over the page; none when absent. */
  readonly heading?: string;
  /** Open a result; `line` is the line it matched on. */
  readonly onOpen: (id: string, line?: number) => void;
  /** Present when there is something to save: the save button. */
  readonly onSave?: () => void;
  readonly saveLabel?: string;
  /** The search field, for a "Search documents" command to focus. */
  readonly searchInput?: RefObject<HTMLInputElement>;
  /** Every loaded row's id, whenever they change. */
  readonly onRendered?: (ids: readonly string[]) => void;
}

export interface SavedSearchProps extends SearchRender {
  /** The saved-search note. */
  readonly row: DocumentRow;
  /** Drawn inside another note: the results alone. */
  readonly embedded?: boolean;
}

/** One note, picked by searching for it. */
export interface NoteSelectProps {
  /** The chosen note's id; none when absent. */
  readonly value?: string;
  readonly onChange: (id: string) => void;
  readonly placeholder?: string;
  /** The accessible name of the box; "Note" by default. */
  readonly label?: string;
  readonly autoFocus?: boolean;
  /** Offer "no note" (chosen as `""`) under this name: "Root", "None". */
  readonly emptyLabel?: string;
  /**
   * The note the picking happens from: the notes nearest it in the folder tree come first,
   * then the last updated. `""` is the root. Since 4.6.0.
   */
  readonly cwd?: string;
  /** Leave these notes out: what is being moved, and what is inside it. Since 4.9.0. Keep it stable (memoized): a new function each render redoes the list. */
  readonly exclude?: (id: string) => boolean;
  /** The list always open under the box, in the page's flow: a sheet that is the picker. Since 4.9.0. */
  readonly inline?: boolean;
}

/** A frontmatter key, typed or picked from the keys in use. Since 4.7.0. */
export interface FmKeySelectProps {
  /** The key, as typed so far: `status`, `project.phase`. */
  readonly value: string;
  /** Every keystroke, and a pick. */
  readonly onChange: (key: string) => void;
  /** A key chosen from the list, after its `onChange`: for a host that acts on a choice, not on typing. Since 4.9.0. */
  readonly onPick?: (key: string) => void;
  /** Fields that are not frontmatter, listed first under their names: `title`, `updated_at`. */
  readonly builtIn?: readonly { readonly key: string; readonly label: string }[];
  readonly placeholder?: string;
  /** The accessible name of the box; "Property" by default. */
  readonly label?: string;
  readonly autoFocus?: boolean;
}

/** A value of one frontmatter key, typed or picked from the values it holds. Since 4.7.0. */
export interface FmValueSelectProps {
  /** Whose values to suggest; none while it is `""`. */
  readonly fmKey: string;
  readonly value: string;
  /** Every keystroke, and a pick. */
  readonly onChange: (value: string) => void;
  /** The whole value after a pick from the list, after its `onChange`. Since 4.9.0. */
  readonly onPick?: (value: string) => void;
  /** A comma-separated list: suggest for, and replace, the last item. */
  readonly multiple?: boolean;
  readonly placeholder?: string;
  /** The accessible name of the box; "Value" by default. */
  readonly label?: string;
  readonly autoFocus?: boolean;
}

export interface ResultsOptions {
  /** Rows per page; 50 by default. */
  readonly pageSize?: number;
  /**
   * Conditions every result must also meet, whatever the search's own filter combines
   * with — a view narrowing to what it can show (a calendar to its month). Since 1.1.0.
   */
  readonly within?: readonly SearchClause[];
}

export interface ResolveOptions {
  readonly limit?: number;
  /** As {@link ResultsOptions.within}. Since 1.1.0. */
  readonly within?: readonly SearchClause[];
}

export interface SaveSearchOptions {
  /** The new note's title; the search text, or "Saved search", by default. */
  readonly title?: string;
  /** Where the note belongs, passed on to `doc-events`' `notifyCreated` as `parent`. */
  readonly parent?: string;
  /** The note's `type`: which view shows it. `table` by default. */
  readonly type?: string;
}

export interface Search {
  /** A search from its query string; junk parts are dropped. */
  readonly parse: (value: string) => SearchSpec;
  /** The query string for a search; `""` for the default one. */
  readonly encode: (spec: SearchSpec) => string;
  /** A React hook: the search's results, live, a page at a time (50 by default). */
  readonly useResults: (spec: SearchSpec, options?: ResultsOptions) => SearchResults;
  /** The search's rows once, for a caller outside React. */
  readonly resolve: (spec: SearchSpec, options?: ResolveOptions) => Promise<readonly DocumentRow[]>;
  /** The search a saved-search note holds, as its query string; `undefined` for any other note. */
  readonly savedSearchOf: (row: DocumentRow) => string | undefined;
  /** Save a search to a new note and open it. Resolves to the note's id. */
  readonly save: (spec: SearchSpec, options?: SaveSearchOptions) => Promise<string>;
  /** A search on screen: its controls over the host's view. */
  readonly SearchShell: ComponentType<SearchShellProps>;
  /** A saved-search note on screen: the shell, with "Update saved search" when the search was changed. */
  readonly SavedSearch: ComponentType<SavedSearchProps>;
  /** A box that searches notes and picks one. */
  readonly NoteSelect: ComponentType<NoteSelectProps>;
  /** A frontmatter key, typed or picked from the keys in use. */
  readonly FmKeySelect: ComponentType<FmKeySelectProps>;
  /** A value of one frontmatter key, typed or picked from the values it holds. */
  readonly FmValueSelect: ComponentType<FmValueSelectProps>;
  /**
   * A new query, written as a chain: `query().filter("title", "text_contains", "a").sort("fm.key").run()`.
   * The shared core's query plan, answered by the kernel's engine. Since 4.11.0.
   */
  readonly query: () => QueryBuilder;
  /** A React hook: a query's answer, live. Since 4.11.0. */
  readonly useQuery: (source: QueryBuilder | QueryPlan | undefined) => QueryState;
}
