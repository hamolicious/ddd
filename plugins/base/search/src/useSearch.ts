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
}

export function useSearch(
  engine: SearchEngine,
  query: string,
  options: UseSearchOptions = {},
): SearchState {
  const { limit = 50, debounceMs = 140, enabled = true } = options;
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
          const hits = mergeHits(results, limit);
          const rows = new Map<string, DocumentRow>();
          await Promise.all(
            hits.map(async (hit) => {
              const row = await engine.row(hit.id);
              if (row) rows.set(hit.id, row);
            }),
          );
          if (token.current !== mine) return;
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
  }, [debounceMs, enabled, engine, limit, query]);

  return state;
}

/** Providers that failed, for the "this needs a network" note. */
export function useProviderErrors(state: SearchState): readonly ProviderResult[] {
  return useMemo(() => state.results.filter((result) => result.error !== undefined), [state.results]);
}
