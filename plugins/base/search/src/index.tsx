/**
 * `search` — the search UI, over a registry of providers (SPEC §6.5).
 *
 * **The default provider is the local index**, and that is a correctness statement,
 * not a performance one: the workspace must be searchable offline (SPEC §4.1), so the
 * thing the search box talks to by default is `kernel.documents.search`, which runs
 * MiniSearch in a Worker against the replicated projection. The server's `?search=`
 * endpoint is contributed as a *second* provider — useful for very large workspaces,
 * scripts and integrations, and honest about needing a network.
 *
 * Two consequences of "provider registry" that this plugin implements rather than
 * assumes:
 *
 * - **Every enabled provider runs, and each one's outcome is reported.** A provider
 *   that throws (the server one, offline) contributes an error line, not an empty page —
 *   `merge.ts` explains why their scores are converted to ranks before merging.
 * - **The local provider is `order: 0`** and therefore wins ties, which is what makes
 *   the offline-correct answer the default answer.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";

import type { Kernel, SearchHit } from "@kernel";

import { queryParam, searchPath } from "./hash.js";
import { mergeHits, type ProviderResult } from "./merge.js";
import { ResultsView } from "./ResultsView.js";
import { SearchBox } from "./SearchBox.js";
import type { SearchEngine } from "./useSearch.js";
import {
  POINTS,
  searchProviderShape,
  type Command,
  type KeybindingDefault,
  type MainView,
  type NavbarItem,
  type Route,
  type SearchProvider,
} from "../../_shared/points.js";

export interface SearchApi {
  /** Run every enabled provider in `order` and merge, best score first. */
  query(
    text: string,
    options?: { readonly limit?: number },
  ): Promise<readonly { id: string; score: number }[]>;
  providers(): readonly SearchProvider[];
  open(initialQuery?: string): void;
}

interface RouterService {
  navigate(path: string, options?: { readonly replace?: boolean }): void;
  onChange(listener: (path: string) => void): () => void;
  current(): string;
}

export default function activate(kernel: Kernel): SearchApi {
  const providers = kernel.extensions.definePoint<SearchProvider>({
    name: POINTS.searchProvider,
    shape: searchProviderShape,
    key: (provider) => provider.id,
    description: "A search backend. The local index is the default (order 0).",
  });

  const router = kernel.services.require<RouterService>("router");

  // The default: local, offline, live.
  kernel.extensions.contribute<SearchProvider>(POINTS.searchProvider, {
    id: "local",
    label: "This device",
    order: 0,
    search: (query, options) => kernel.documents.search(query, options),
  });

  // The fallback: the server's materialized index. Needs a network, and says so.
  kernel.extensions.contribute<SearchProvider>(POINTS.searchProvider, {
    id: "server",
    label: "Server (needs a network)",
    order: 10,
    search: async (query, options) => {
      const params = new URLSearchParams({ search: query, limit: String(options.limit ?? 50) });
      // The server's list endpoint is metadata-only here: content comes from the local
      // projection, which every client already has (SPEC §4.1). Asking for a megabyte of
      // text the client can read locally is the definition of browsing over REST.
      params.set("metadata_only", "true");
      const response = await kernel.session.fetch(`/documents?${params.toString()}`);
      const body = (await response.json()) as { documents?: readonly { id: string }[] };
      return (body.documents ?? []).map(
        (row, index): SearchHit => ({ id: row.id, score: 1 / (index + 1), terms: [] }),
      );
    },
  });

  /** Providers in `order`, which is also the tie-break order in the merge. */
  const orderedProviders = (): readonly SearchProvider[] =>
    [...providers.get()].sort((a, b) => (a.order ?? 100) - (b.order ?? 100));

  /**
   * Run every provider. One provider's failure is recorded, never thrown: offline, the
   * server provider always fails and the local one always works.
   */
  const runProviders = async (
    query: string,
    options: { readonly limit?: number },
  ): Promise<readonly ProviderResult[]> =>
    Promise.all(
      orderedProviders().map(async (provider): Promise<ProviderResult> => {
        const base = { providerId: provider.id, label: provider.label, order: provider.order ?? 100 };
        try {
          const hits = await provider.search(query, {
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
          });
          return { ...base, hits };
        } catch (cause) {
          kernel.log.debug(`search provider "${provider.id}" failed`, cause);
          return {
            ...base,
            hits: [],
            error: cause instanceof Error ? cause.message : String(cause),
          };
        }
      }),
    );

  const engine: SearchEngine = {
    run: (query, options) => runProviders(query, options),
    row: (id) => kernel.documents.get(id),
  };

  const openDocument = (id: string): void => router.navigate(`/doc/${id}`);

  // ---------------------------------------------------------------------------
  // Contributions
  // ---------------------------------------------------------------------------

  const BoxHost = (): ReactElement => (
    <SearchBox
      engine={engine}
      onOpenDocument={openDocument}
      onOpenResults={(query) => router.navigate(searchPath(query))}
    />
  );

  kernel.extensions.contribute<NavbarItem>(POINTS.navbarItem, {
    id: "search.box",
    label: "Search",
    side: "start",
    order: 30,
    onSelect: () => api.open(),
    component: BoxHost,
  });

  const ResultsHost = (): ReactElement => {
    const [query, setQuery] = useState(() => queryParam(location.hash, "q"));
    const [count, setCount] = useState<number | undefined>(undefined);

    // The URL is the state. A hash change (back, a link, the navbar box) re-reads it.
    useEffect(() => router.onChange(() => setQuery(queryParam(location.hash, "q"))), []);

    // "No matches" and "the index is still building" look identical without this.
    useEffect(() => {
      let cancelled = false;
      void kernel.documents.query({ limit: 1 }).then((result) => {
        if (!cancelled) setCount(result.total);
      });
      return () => {
        cancelled = true;
      };
    }, []);

    return (
      <ResultsView
        engine={engine}
        initialQuery={query}
        onOpenDocument={openDocument}
        onQueryChange={(next) => router.navigate(searchPath(next))}
        {...(count !== undefined ? { documentCount: count } : {})}
      />
    );
  };

  kernel.extensions.contribute<Route>(POINTS.route, { path: "/search", view: "search.results" });
  kernel.extensions.contribute<MainView>(POINTS.mainView, {
    id: "search.results",
    title: "Search",
    component: ResultsHost,
  });

  kernel.extensions.contribute<Command>(POINTS.command, {
    id: "search.open",
    title: "Search documents",
    category: "Search",
    run: () => api.open(),
  });
  kernel.extensions.contribute<KeybindingDefault>(POINTS.keybinding, {
    command: "search.open",
    keys: "Mod+Shift+F",
  });

  const api: SearchApi = {
    query: async (text, options) => {
      const results = await runProviders(text, options ?? {});
      return mergeHits(results, options?.limit).map((hit) => ({ id: hit.id, score: hit.score }));
    },
    providers: () => providers.get(),
    open: (initialQuery = "") => router.navigate(searchPath(initialQuery)),
  };

  return api;
}
