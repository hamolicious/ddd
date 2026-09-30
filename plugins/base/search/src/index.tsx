/**
 * `search` — searching the workspace, for every plugin that shows search results.
 *
 * - **The providers** (`providers.ts`): the registry other plugins add to with
 *   `addProvider`, and the two this plugin adds — the local index, first, and the server.
 * - **A search is a spec** (`spec.ts`): text, filter and sort, as one query string — the
 *   list's URL and a saved-search note hold the same one.
 * - **Resolving one** (`results.ts`): the providers find ids for the text, and a live
 *   local query runs the filter and the sort over them.
 * - **`SearchShell`** (`SearchShell.tsx`) is a search on screen: the controls over the
 *   host's view. How results are drawn is the host's: the `table`, `kanban`, `calendar`
 *   and `timeline` plugins each draw their own.
 * - **Saved searches** (`saved.ts`): a note whose `saved-search` frontmatter holds a spec.
 *   `SavedSearch` is the shell for one; each view plugin's document mode claims the
 *   saved searches whose `type` names it and draws itself inside it.
 * - **Components** (`components/`): the pieces other plugins build with — `NoteSelect`,
 *   `FmKeySelect` and `FmValueSelect`, boxes that pick a note, a frontmatter key and one of
 *   its values. `NoteSelect` draws each note as the folder tree does
 *   (`setNoteLooks`, which `folders` calls: it cannot be a dependency of this plugin,
 *   since `folders` optionally depends on this one).
 *
 * Everything is a named export of this module (`plugin:search`). `parse`, `encode`,
 * `savedSearchOf` and `addProvider` work at any time; the rest needs this plugin active.
 */

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
import { createNoteSelect, type NoteLooks } from "./components/NoteSelect.js";
import { searchEngine } from "./providers.js";
import { resolveSearch, useResults as useResultsWith } from "./results.js";
import { SAVED_SEARCH_KEY, savedSearchNoteText, savedSearchOf as savedSearchOfRow, savedSearchTitle } from "./saved.js";
import { createSavedSearch } from "./SavedSearch.js";
import { createSearchShell } from "./SearchShell.js";
import { documentPath, encodeSpec, parseSpec } from "./spec.js";

export type { NoteLooks } from "./components/NoteSelect.js";
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

// ---------------------------------------------------------------------------
// Available at any time
// ---------------------------------------------------------------------------

/** Add a search provider (or several). Returns the function that takes it out again. */
export const addProvider: (items: SearchProvider | readonly SearchProvider[]) => () => void = providerRegistry.add;

let noteLooks: NoteLooks | undefined;
const looksListeners = new Set<() => void>();

/**
 * How `NoteSelect` dresses notes: `folders`' `look` and `onLookChange`. Returns the function
 * that takes them away again. Since 4.5.0.
 */
export function setNoteLooks(looks: NoteLooks): () => void {
  noteLooks = looks;
  for (const listener of [...looksListeners]) listener();
  return () => {
    if (noteLooks !== looks) return;
    noteLooks = undefined;
    for (const listener of [...looksListeners]) listener();
  };
}

/** A search from its query string; junk parts are dropped. */
export function parse(value: string): SearchSpec {
  return parseSpec(value);
}

/** The query string for a search; `""` for the default one. */
export function encode(spec: SearchSpec): string {
  return encodeSpec(spec);
}

/** The search a saved-search note holds, as its query string; `undefined` for any other note. */
export function savedSearchOf(row: DocumentRow): string | undefined {
  return savedSearchOfRow(row);
}

// ---------------------------------------------------------------------------
// Bound to the kernel in `activate`
// ---------------------------------------------------------------------------

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

/** A React hook: the search's results, live, a page at a time (50 by default). */
export function useResults(spec: SearchSpec, options?: ResultsOptions): SearchResults {
  return need().useResults(spec, options);
}

/** The search's rows once, for a caller outside React. */
export function resolve(spec: SearchSpec, options?: ResolveOptions): Promise<readonly DocumentRow[]> {
  return need().resolve(spec, options);
}

/** Save a search to a new note and open it. Resolves to the note's id. */
export function save(spec: SearchSpec, options?: SaveSearchOptions): Promise<string> {
  return need().save(spec, options);
}

/** A search on screen: its controls over the host's view. */
export function SearchShell(props: SearchShellProps): ReactElement {
  const Shell = need().SearchShell;
  return <Shell {...props} />;
}

/** A saved-search note on screen: the shell, with "Update saved search" when the search was changed. */
export function SavedSearch(props: SavedSearchProps): ReactElement {
  const Saved = need().SavedSearch;
  return <Saved {...props} />;
}

/** A box that searches notes and picks one; the value is the note's id. */
export function NoteSelect(props: NoteSelectProps): ReactElement {
  const Select = need().NoteSelect;
  return <Select {...props} />;
}

/** A frontmatter key, typed or picked from the keys in use. */
export function FmKeySelect(props: FmKeySelectProps): ReactElement {
  const Select = need().FmKeySelect;
  return <Select {...props} />;
}

/** A value of one frontmatter key, typed or picked from the values it holds. */
export function FmValueSelect(props: FmValueSelectProps): ReactElement {
  const Select = need().FmValueSelect;
  return <Select {...props} />;
}

export default function activate(kernel: Kernel): void {
  // Optional: no router, no opening a result; no commands, no Actions menu; no icons, none
  // in it. Nothing needs them before a click, so the lookups do not hold up activation.
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

  // The indexer's module namespace is the index: `version` is its live binding.
  const index = (): ConditionIndex => indexer;

  const engine = searchEngine(kernel, providerRegistry);

  const open = (id: string, line?: number): void => router?.navigate(documentPath(id, line));

  /** The Actions menu: every command that takes documents, run with the results' ids. */
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

  const NoteSelect = createNoteSelect({
    documents: kernel.documents,
    index: indexer,
    looks: () => noteLooks,
    onLooksSet: (listener): Unsubscribe => {
      looksListeners.add(listener);
      return () => {
        looksListeners.delete(listener);
      };
    },
  });

  const { FmKeySelect, FmValueSelect } = createFmSelects(indexer);

  const Shell = createSearchShell({
    kernel,
    engine,
    menu: { open: openMenu },
    index,
    actions: () => (commands ? openActions : undefined),
    NoteSelect,
    FmKeySelect,
    FmValueSelect,
  });

  /** A new note holding the search, filed like any new document, then opened. */
  const saveSearch = async (spec: SearchSpec, options?: SaveSearchOptions): Promise<string> => {
    const title = options?.title ?? savedSearchTitle(spec.query);
    const id = await kernel.documents.create({ text: savedSearchNoteText(title, encodeSpec(spec), [options?.type ?? "table"]) });
    notifyCreated(options?.parent !== undefined ? { id, parent: options.parent } : { id });
    open(id);
    return id;
  };

  /** Rewrite a saved search's one key: a splice, so nothing else in the note moves. */
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
    resolve: (spec, options) => resolveSearch(kernel.documents, engine, spec, options ?? {}),
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
}
