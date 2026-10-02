import type { ComponentType, ReactElement } from "react";

import type { DocumentRow, Kernel, Unsubscribe } from "@kernel";
import { open as openMenu } from "plugin:context-menu";
import { notifyCreated } from "plugin:doc-events";
import * as indexer from "plugin:indexer";

import type { ConditionIndex } from "../../_shared/conditions-index.js";

import {
  providerRegistry,
  type FmKeySelectProps,
  type FmValueSelectProps,
  type NoteSelectProps,
  type ResolveOptions,
  type ResultsOptions,
  type SavedSearchProps,
  type SaveSearchOptions,
  type SearchProvider,
  type SearchResults,
  type SearchShellProps,
  type SearchSpec,
} from "./api.js";
import { createFmSelects } from "./components/FmSelect.js";
import { createNoteSelect } from "./components/NoteSelect.js";
import { createNoteHooks, type NoteLooks } from "./components/notes.js";
import { searchEngine } from "./providers.js";
import { resolveSearch, useResults as useResultsWith } from "./results.js";
import { SAVED_SEARCH_KEY, savedSearchNoteText, savedSearchOf as savedSearchOfRow, savedSearchTitle } from "./saved.js";
import { bindDocuments } from "./query.js";
import { createSavedSearch } from "./SavedSearch.js";
import { createSearchShell } from "./SearchShell.js";
import { documentPath, encodeSpec, parseSpec } from "./spec.js";

export type { NoteLooks } from "./components/notes.js";
export {
  QueryBuilder,
  QueryError,
  query,
  useQuery,
  type QueryOp,
  type QueryState,
  type QueryValue,
} from "./query.js";
export type {
  FmKeySelectProps,
  FmValueSelectProps,
  NoteSelectProps,
  ResolveOptions,
  ResultsOptions,
  SavedSearchProps,
  SaveSearchOptions,
  Search,
  SearchClause,
  SearchField,
  SearchFilter,
  SearchProvider,
  SearchRender,
  SearchResults,
  SearchShellProps,
  SearchSnippet,
  SearchSort,
  SearchSpec,
  SearchViewProps,
} from "./api.js";

type RouterModule = typeof import("plugin:router");
type CommandsModule = typeof import("plugin:commands");
type IconsModule = typeof import("plugin:icons");

export const addProvider: (items: SearchProvider | readonly SearchProvider[]) => () => void = providerRegistry.add;

let noteLooks: NoteLooks | undefined;
const looksListeners = new Set<() => void>();

export function setNoteLooks(looks: NoteLooks): () => void {
  noteLooks = looks;
  for (const listener of [...looksListeners]) listener();
  return () => {
    if (noteLooks !== looks) return;
    noteLooks = undefined;
    for (const listener of [...looksListeners]) listener();
  };
}

export function parse(value: string): SearchSpec {
  return parseSpec(value);
}

export function encode(spec: SearchSpec): string {
  return encodeSpec(spec);
}

export function savedSearchOf(row: DocumentRow): string | undefined {
  return savedSearchOfRow(row);
}

interface Active {
  readonly useResults: (spec: SearchSpec, options?: ResultsOptions) => SearchResults;
  readonly resolve: (spec: SearchSpec, options?: ResolveOptions) => Promise<readonly DocumentRow[]>;
  readonly save: (spec: SearchSpec, options?: SaveSearchOptions) => Promise<string>;
  readonly SearchShell: ComponentType<SearchShellProps>;
  readonly SavedSearch: ComponentType<SavedSearchProps>;
  readonly NoteSelect: ComponentType<NoteSelectProps>;
  readonly FmKeySelect: ComponentType<FmKeySelectProps>;
  readonly FmValueSelect: ComponentType<FmValueSelectProps>;
}

let active: Active | undefined;

function need(): Active {
  if (!active) throw new Error("search is not active yet: call it from your plugin's activate() or later");
  return active;
}

export function useResults(spec: SearchSpec, options?: ResultsOptions): SearchResults {
  return need().useResults(spec, options);
}

export function resolve(spec: SearchSpec, options?: ResolveOptions): Promise<readonly DocumentRow[]> {
  return need().resolve(spec, options);
}

export function save(spec: SearchSpec, options?: SaveSearchOptions): Promise<string> {
  return need().save(spec, options);
}

export function SearchShell(props: SearchShellProps): ReactElement {
  const Shell = need().SearchShell;
  return <Shell {...props} />;
}

export function SavedSearch(props: SavedSearchProps): ReactElement {
  const Saved = need().SavedSearch;
  return <Saved {...props} />;
}

export function NoteSelect(props: NoteSelectProps): ReactElement {
  const Select = need().NoteSelect;
  return <Select {...props} />;
}

export function FmKeySelect(props: FmKeySelectProps): ReactElement {
  const Select = need().FmKeySelect;
  return <Select {...props} />;
}

export function FmValueSelect(props: FmValueSelectProps): ReactElement {
  const Select = need().FmValueSelect;
  return <Select {...props} />;
}

export default function activate(kernel: Kernel): void {
  bindDocuments(kernel.documents);
  let router: RouterModule | undefined;
  let commands: CommandsModule | undefined;
  let icons: IconsModule | undefined;
  const lookup = <M,>(id: string, set: (module: M | undefined) => void): void => {
    void kernel.plugins
      .optional<M>(id)
      .then(set)
      .catch((cause: unknown) => kernel.log.warn(`${id} unavailable`, cause));
  };
  lookup<RouterModule>("router", (module) => (router = module));
  lookup<CommandsModule>("commands", (module) => (commands = module));
  lookup<IconsModule>("icons", (module) => (icons = module));

  const index = (): ConditionIndex => indexer;

  const engine = searchEngine(kernel, providerRegistry);

  const open = (id: string, line?: number): void => router?.navigate(documentPath(id, line));

  const openActions = (ids: readonly string[], anchor: HTMLElement): void => {
    const registry = commands;
    const Icon = icons?.Icon;
    const available = (registry?.list() ?? []).filter((command) => command.takes === "documents");
    openMenu({
      title: `${ids.length.toLocaleString()} document${ids.length === 1 ? "" : "s"}`,
      anchor,
      sections: [
        {
          items:
            available.length === 0
              ? [{ id: "none", label: "No actions available", disabled: true, run: () => undefined }]
              : available.map((command) => ({
                  id: command.id,
                  label: command.title,
                  ...(Icon && command.icon !== undefined ? { icon: <Icon name={command.icon} /> } : {}),
                  run: () => {
                    void registry?.run(command.id, ids).catch((cause: unknown) => {
                      kernel.log.error(`command "${command.id}" failed`, cause);
                      kernel.ui.notify({
                        id: "search.action-failed",
                        level: "error",
                        message: `${command.title} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
                      });
                    });
                  },
                })),
        },
      ],
    });
  };

  const notes = createNoteHooks({
    index: indexer,
    looks: () => noteLooks,
    onLooksSet: (listener): Unsubscribe => {
      looksListeners.add(listener);
      return () => {
        looksListeners.delete(listener);
      };
    },
  });
  const NoteSelect = createNoteSelect({ documents: kernel.documents, notes });

  const { FmKeySelect, FmValueSelect } = createFmSelects(indexer, notes);

  const Shell = createSearchShell({
    kernel,
    engine,
    menu: { open: openMenu },
    icons: () => icons,
    index,
    actions: () => (commands ? openActions : undefined),
    NoteSelect,
    FmKeySelect,
    FmValueSelect,
  });

  const saveSearch = async (spec: SearchSpec, options?: SaveSearchOptions): Promise<string> => {
    const title = options?.title ?? savedSearchTitle(spec.query);
    const id = await kernel.documents.create({ text: savedSearchNoteText(title, encodeSpec(spec), [options?.type ?? "table"]) });
    notifyCreated(options?.parent !== undefined ? { id, parent: options.parent } : { id });
    open(id);
    return id;
  };

  const update = (id: string, value: string): void => {
    void kernel.documents.splice.setFrontmatterValue(id, SAVED_SEARCH_KEY, value).catch((cause: unknown) => {
      kernel.log.error("could not update the saved search", cause);
      kernel.ui.notify({
        id: "search.update-failed",
        level: "error",
        message: `Could not update the saved search: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    });
  };

  active = {
    useResults: (spec, options) => useResultsWith(kernel.documents, engine, spec, options ?? {}),
    resolve: (spec, options) => resolveSearch(kernel.documents, spec, options ?? {}),
    save: saveSearch,
    SearchShell: Shell,
    SavedSearch: createSavedSearch({ SearchShell: Shell, open, update }),
    NoteSelect,
    FmKeySelect,
    FmValueSelect,
  };
}

export function deactivate(): void {
  active = undefined;
  bindDocuments(undefined);
}
