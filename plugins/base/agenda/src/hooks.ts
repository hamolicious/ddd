/**
 * The two React bindings the agenda needs: a live projection query, and the live task-state
 * registry.
 *
 * Both are "subscribe, re-render, unsubscribe" and both have a failure mode that only shows
 * up in a running app, which is why they are one file rather than inline `useEffect`s:
 *
 * - **One subscription per query, closed on unmount and on query change.** A leaked
 *   subscription re-renders this view on every change to every document, forever.
 * - **The query is compared by value**, because the caller builds a new object each render.
 * - **An in-flight `subscribe` that resolves after unmount is closed immediately.**
 * - **The registry is read live** (SPEC §6.4: `get`/`subscribe` are live): a plugin that
 *   contributes `markdown.taskState` may activate after this view first renders, and a
 *   panel that read the registry once at activation would show its markers as unrecognized
 *   until the next reload.
 *
 * INTEGRATION (base-docs / base-tools): `doc-list/src/useLiveQuery.ts` is the same hook,
 * and `admin/src/hooks.ts` is a third variant of the same idea. Three copies is the cost of
 * "no direct imports between plugins" (SPEC §6.1) for something every list-shaped plugin
 * needs. If the kernel ever ships React bindings — `@kernel/react` with `useLiveQuery` and
 * `useContributions` — this file and its two siblings delete themselves; until then the
 * duplication is deliberate and the behaviour above is the part that must not drift.
 */

import { useEffect, useMemo, useRef, useState } from "react";

import type { DocumentQuery, DocumentQueryResult, DocumentsApi, ExtensionsApi } from "@kernel";

export interface LiveQueryState {
  readonly rows: DocumentQueryResult["rows"];
  /** Matches before `limit` — how the view knows it is showing a truncated list. */
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
        const off = subscription.onChange((result) => {
          if (!live) return;
          setState({ rows: result.rows, total: result.total, loading: false });
        });
        close = () => {
          off();
          subscription.close();
        };
        setState({
          rows: subscription.result.rows,
          total: subscription.result.total,
          loading: false,
        });
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

/** Live contributions to one extension point. `subscribe` fires immediately. */
export function useContributions<T>(extensions: ExtensionsApi, point: string): readonly T[] {
  const [values, setValues] = useState<readonly T[]>(() => extensions.get<T>(point));
  useEffect(() => extensions.subscribe<T>(point, setValues), [extensions, point]);
  return values;
}
