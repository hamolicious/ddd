import type { ComponentType, ReactNode, RefObject } from "react";

import { createRegistry, s } from "@kernel";
import type { DocumentRow, QueryPlan, SearchHit } from "@kernel";

import type { QueryBuilder, QueryState } from "./query.js";

export interface SearchProvider {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly search: (
    query: string,
    options: { readonly limit?: number; readonly includeDeleted?: boolean },
  ) => Promise<readonly SearchHit[]>;
}

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

export interface SearchClause {
  readonly id: string;
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
  readonly includeMachine?: boolean;
}

export interface SearchSort {
  readonly field: string;
  readonly direction: "asc" | "desc";
}

export interface SearchSpec {
  readonly query: string;
  readonly filter: SearchFilter;
  readonly sort?: SearchSort;
}

export interface SearchSnippet {
  readonly text: string;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly line: number;
}

export interface SearchResults {
  readonly rows: readonly DocumentRow[];
  readonly total?: number;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly partial: boolean;
  readonly error?: string;
  readonly more: () => void;
  readonly snippetOf: (row: DocumentRow) => SearchSnippet | undefined;
}

export interface SearchViewProps {
  readonly spec: SearchSpec;
  readonly results: SearchResults;
  readonly sort: SearchSort;
  readonly onSortChange: (sort: SearchSort) => void;
  readonly onOpen: (id: string, line?: number) => void;
  readonly embedded: boolean;
  readonly editing?: boolean;
}

export interface SearchField {
  readonly field: string;
  readonly label: string;
  readonly kind?: string;
}

export interface SearchRender {
  readonly renderView: (props: SearchViewProps) => ReactNode;
  readonly renderSettings?: (fields: readonly SearchField[]) => ReactNode;
  readonly pageSize?: number;
  readonly showsEmpty?: boolean;
}

export interface SearchShellProps extends SearchRender {
  readonly spec: SearchSpec;
  readonly onSpecChange: (spec: SearchSpec) => void;
  readonly controls?: "shown" | "folded" | "hidden";
  readonly heading?: string;
  readonly onOpen: (id: string, line?: number) => void;
  readonly onSave?: () => void;
  readonly saveLabel?: string;
  readonly searchInput?: RefObject<HTMLInputElement>;
  readonly onRendered?: (ids: readonly string[]) => void;
}

export interface SavedSearchProps extends SearchRender {
  readonly row: DocumentRow;
  readonly embedded?: boolean;
}

export interface NoteSelectProps {
  readonly value?: string;
  readonly onChange: (id: string) => void;
  readonly placeholder?: string;
  readonly label?: string;
  readonly autoFocus?: boolean;
  readonly emptyLabel?: string;
  readonly cwd?: string;
  readonly exclude?: (id: string) => boolean;
  readonly inline?: boolean;
}

export interface FmKeySelectProps {
  readonly value: string;
  readonly onChange: (key: string) => void;
  readonly onPick?: (key: string) => void;
  readonly builtIn?: readonly { readonly key: string; readonly label: string }[];
  readonly placeholder?: string;
  readonly label?: string;
  readonly autoFocus?: boolean;
}

export interface FmValueSelectProps {
  readonly fmKey: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onPick?: (value: string) => void;
  readonly multiple?: boolean;
  readonly placeholder?: string;
  readonly label?: string;
  readonly autoFocus?: boolean;
}

export interface ResultsOptions {
  readonly pageSize?: number;
  readonly within?: readonly SearchClause[];
}

export interface ResolveOptions {
  readonly limit?: number;
  readonly within?: readonly SearchClause[];
}

export interface SaveSearchOptions {
  readonly title?: string;
  readonly parent?: string;
  readonly type?: string;
}

export interface Search {
  readonly parse: (value: string) => SearchSpec;
  readonly encode: (spec: SearchSpec) => string;
  readonly useResults: (spec: SearchSpec, options?: ResultsOptions) => SearchResults;
  readonly resolve: (spec: SearchSpec, options?: ResolveOptions) => Promise<readonly DocumentRow[]>;
  readonly savedSearchOf: (row: DocumentRow) => string | undefined;
  readonly save: (spec: SearchSpec, options?: SaveSearchOptions) => Promise<string>;
  readonly SearchShell: ComponentType<SearchShellProps>;
  readonly SavedSearch: ComponentType<SavedSearchProps>;
  readonly NoteSelect: ComponentType<NoteSelectProps>;
  readonly FmKeySelect: ComponentType<FmKeySelectProps>;
  readonly FmValueSelect: ComponentType<FmValueSelectProps>;
  readonly query: () => QueryBuilder;
  readonly useQuery: (source: QueryBuilder | QueryPlan | undefined) => QueryState;
}
