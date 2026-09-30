/**
 * The debounced, cancellable search behind the list's search bar.
 *
 * Two properties it has to hold, and both are about not lying to the user:
 *
 * - **Stale answers never win.** Every run carries a token; a reply from an older query
 *   is dropped. Without that, typing "milk" fast enough shows the results for "mil"
 *   whenever the shorter query's provider happened to be slower.
 * - **A provider's failure is that provider's failure.** The local index works offline
 *   and the server provider does not (SPEC §6.5); one throwing must leave the other's
 *   results on screen with a note, not blank the list.
 *
 * - **The device answers first.** Results are shown as each provider answers, so the
 *   local index is on screen while a slower provider (the server) is still out; `running`
 *   stays true until the last one is in.
 *
 * It returns ranked ids and nothing else. Rows, filters and machine-document hiding are
 * the list's own live query, run over these ids (`DocListView`), so a search result
 * obeys the same filters as the list it replaces and updates as live as it does.
 */

import { useEffect, useRef, useState } from "react";

import { mergeHits, type MergedHit, type ProviderResult } from "./merge.js";

export interface SearchEngine {
  /**
   * Runs every enabled provider and reports each one's outcome. `onProgress` is called with
   * the answers so far each time a provider answers, in seat order.
   */
  run(
    query: string,
    options: { readonly limit?: number },
    onProgress?: (results: readonly ProviderResult[]) => void,
  ): Promise<readonly ProviderResult[]>;
}

export interface SearchState {
  /** The query these results are for — trails the caller's `query` while typing. */
  readonly settled: string;
  readonly running: boolean;
  readonly results: readonly ProviderResult[];
  readonly hits: readonly MergedHit[];
}

const IDLE: SearchState = { settled: "", running: false, results: [], hits: [] };

export function useSearch(
  engine: SearchEngine,
  query: string,
  options: { readonly limit?: number; readonly debounceMs?: number } = {},
): SearchState {
  const { limit = 50, debounceMs = 140 } = options;
  const [state, setState] = useState<SearchState>(IDLE);
  const token = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed === "") {
      token.current += 1;
      setState(IDLE);
      return undefined;
    }

    const mine = ++token.current;
    setState((current) => ({ ...current, running: true }));

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const results = await engine.run(trimmed, { limit }, (partial) => {
            if (token.current !== mine) return;
            setState({ settled: trimmed, running: true, results: partial, hits: mergeHits(partial, limit) });
          });
          if (token.current !== mine) return;
          setState({ settled: trimmed, running: false, results, hits: mergeHits(results, limit) });
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
          });
        }
      })();
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [debounceMs, engine, limit, query]);

  return state;
}
