/**
 * The debounced, cancellable search hook shared by the navbar box and the results view.
 *
 * Two properties it has to hold, and both are about not lying to the user:
 *
 * - **Stale answers never win.** Every run carries a token; a reply from an older query
 *   is dropped. Without that, typing "milk" fast enough shows the results for "mil"
 *   whenever the shorter query's provider happened to be slower.
 * - **A provider's failure is that provider's failure.** The local index works offline
 *   and the server provider does not (SPEC §6.5); one throwing must leave the other's
 *   results on screen with a per-provider note, not blank the page.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { DocumentRow } from "@kernel";

import { isMachineDocument } from "../../_shared/machine-docs.js";

import { mergeHits, type MergedHit, type ProviderResult } from "./merge.js";

export interface SearchEngine {
  /** Runs every enabled provider and reports each one's outcome. */
  run(query: string, options: { readonly limit?: number }): Promise<readonly ProviderResult[]>;
  /** The projection row for a hit, for its title and snippet. */
  row(id: string): Promise<DocumentRow | undefined>;
}

export interface SearchState {
  /** The query these results are for — may trail the caller's `query` while typing. */
  readonly settled: string;
  readonly running: boolean;
  readonly results: readonly ProviderResult[];
  readonly hits: readonly MergedHit[];
  readonly rows: ReadonlyMap<string, DocumentRow>;
}

export interface UseSearchOptions {
  readonly limit?: number;
  readonly debounceMs?: number;
  /** `false` keeps the hook idle (a closed search box does not query). */
  readonly enabled?: boolean;
  /**
   * Include machine-owned documents — `fm.path` starting with `.`, such as the
   * kernel's per-user settings documents (`_shared/machine-docs.ts`). Off by default.
   *
   * The filtering happens **here rather than in the providers**, and that is the
   * reason this option exists at all: a provider is an extension point anyone may
   * contribute to (`search.provider`), and the local index and the server's `$text`
   * index have no shared notion of `fm.path` to filter on. Rows are already fetched
   * for every hit — for the title and the snippet — so the view that has them is the
   * one place a consistent answer can be given across every provider.
   *
   * The consequence is stated rather than hidden: the **per-provider counts above the
   * list are the providers' own**, so they can exceed the number of results shown when
   * a query matches a settings document. That is the honest way round — a count that
   * silently disagreed with what the provider returned would make a failing provider
   * indistinguishable from a filtered one.
   */
  readonly includeMachine?: boolean;
}

export function useSearch(
  engine: SearchEngine,
  query: string,
  options: UseSearchOptions = {},
): SearchState {
  const { limit = 50, debounceMs = 140, enabled = true, includeMachine = false } = options;
  const [state, setState] = useState<SearchState>({
    settled: "",
    running: false,
    results: [],
    hits: [],
    rows: new Map(),
  });
  const token = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || trimmed === "") {
      token.current += 1;
      setState({ settled: trimmed, running: false, results: [], hits: [], rows: new Map() });
      return undefined;
    }

    const mine = ++token.current;
    setState((current) => ({ ...current, running: true }));

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const results = await engine.run(trimmed, { limit });
          if (token.current !== mine) return;
          const merged = mergeHits(results, limit);
          const rows = new Map<string, DocumentRow>();
          await Promise.all(
            merged.map(async (hit) => {
              const row = await engine.row(hit.id);
              if (row) rows.set(hit.id, row);
            }),
          );
          if (token.current !== mine) return;
          // A hit whose row could not be fetched is **kept**: it is a real document the
          // provider found, this client just has no projection row for it (a
          // metadata-only server result on a cold client), and dropping it would make
          // the offline/online answer differ for a reason the user cannot see.
          const hits = includeMachine
            ? merged
            : merged.filter((hit) => {
                const row = rows.get(hit.id);
                return row === undefined || !isMachineDocument(row);
              });
          setState({ settled: trimmed, running: false, results, hits, rows });
        } catch (cause) {
          if (token.current !== mine) return;
          // A throw here is the *merge* failing, not a provider: providers report their
          // own errors through `ProviderResult.error`.
          setState({
            settled: trimmed,
            running: false,
            results: [
              {
                providerId: "search",
                label: "Search",
                order: 0,
                hits: [],
                error: cause instanceof Error ? cause.message : String(cause),
              },
            ],
            hits: [],
            rows: new Map(),
          });
        }
      })();
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [debounceMs, enabled, engine, includeMachine, limit, query]);

  return state;
}

/** Providers that failed, for the "this needs a network" note. */
export function useProviderErrors(state: SearchState): readonly ProviderResult[] {
  return useMemo(() => state.results.filter((result) => result.error !== undefined), [state.results]);
}
