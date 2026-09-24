/**
 * A live local query as a React hook.
 *
 * `kernel.documents.subscribe` is the whole reason this plugin needs no polling and no
 * REST browsing (SPEC §4.1, §4.2): the projection is in IndexedDB, the filter runs
 * through the shared Wasm evaluator, and the subscription re-runs only when a change can
 * alter the result. What the hook adds is the React-shaped part of that contract:
 *
 * - **One subscription per query**, closed on unmount or when the query changes. A leaked
 *   subscription is a re-render on every keystroke in every other document, forever.
 * - **The query is compared by value.** The caller builds a new object every render;
 *   comparing by identity would tear the subscription down and rebuild it each time.
 * - **An in-flight `subscribe` that resolves after unmount is closed immediately**, not
 *   left holding a listener on a dead component.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { DocumentQuery, DocumentQueryResult, DocumentsApi } from "@kernel";

export interface LiveQueryState {
  readonly rows: DocumentQueryResult["rows"];
  readonly total: number;
  readonly loading: boolean;
  readonly error?: string;
}

const EMPTY: LiveQueryState = { rows: [], total: 0, loading: true };

export function useLiveQuery(documents: DocumentsApi, query: DocumentQuery): LiveQueryState {
  const key = useMemo(() => JSON.stringify(query), [query]);
  const stable = useRef<DocumentQuery>(query);
  if (JSON.stringify(stable.current) !== key) stable.current = query;

  const [state, setState] = useState<LiveQueryState>(EMPTY);

  useEffect(() => {
    let live = true;
    let close: (() => void) | undefined;
    setState((current) => ({ ...current, loading: true }));

    void (async () => {
      try {
        const subscription = await documents.subscribe(stable.current);
        if (!live) {
          subscription.close();
          return;
        }
        close = () => subscription.close();
        setState({ rows: subscription.result.rows, total: subscription.result.total, loading: false });
        const off = subscription.onChange((result) => {
          if (!live) return;
          setState({ rows: result.rows, total: result.total, loading: false });
        });
        const previous = close;
        close = () => {
          off();
          previous();
        };
      } catch (cause) {
        if (!live) return;
        setState({
          rows: [],
          total: 0,
          loading: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    })();

    return () => {
      live = false;
      close?.();
    };
  }, [documents, key]);

  return state;
}
