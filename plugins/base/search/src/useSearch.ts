import { useEffect, useRef, useState } from "react";

import { mergeHits, type MergedHit, type ProviderResult } from "./merge.js";

export interface SearchEngine {
  run(
    query: string,
    options: { readonly limit?: number },
    onProgress?: (results: readonly ProviderResult[]) => void,
  ): Promise<readonly ProviderResult[]>;
}

export interface SearchState {
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
