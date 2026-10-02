import { useEffect, useMemo, useRef, useState } from "react";

import type { DocumentQuery, DocumentQueryResult, DocumentsApi, PlanResult, QueryPlan } from "@kernel";

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

export interface LivePlanState {
  readonly rows: PlanResult["rows"];
  readonly total: number;
  readonly hits: PlanResult["hits"];
  readonly loading: boolean;
  readonly error?: string;
}

const EMPTY_PLAN: LivePlanState = { rows: [], total: 0, hits: {}, loading: true };

export function useLivePlan(documents: DocumentsApi, plan: QueryPlan | undefined): LivePlanState {
  const key = plan === undefined ? "" : JSON.stringify(plan);
  const stable = useRef<QueryPlan | undefined>(plan);
  if ((stable.current === undefined ? "" : JSON.stringify(stable.current)) !== key) stable.current = plan;

  const [state, setState] = useState<LivePlanState>(plan === undefined ? { ...EMPTY_PLAN, loading: false } : EMPTY_PLAN);

  useEffect(() => {
    const current = stable.current;
    if (current === undefined) {
      setState({ ...EMPTY_PLAN, loading: false });
      return undefined;
    }
    let live = true;
    let close: (() => void) | undefined;
    setState((previous) => ({ ...previous, loading: true }));

    void (async () => {
      try {
        const subscription = await documents.subscribePlan(current);
        if (!live) {
          subscription.close();
          return;
        }
        const show = (result: PlanResult): void =>
          setState({ rows: result.rows, total: result.total, hits: result.hits, loading: false });
        show(subscription.result);
        const off = subscription.onChange((result) => {
          if (live) show(result);
        });
        close = () => {
          off();
          subscription.close();
        };
      } catch (cause) {
        if (!live) return;
        setState({ ...EMPTY_PLAN, loading: false, error: cause instanceof Error ? cause.message : String(cause) });
      }
    })();

    return () => {
      live = false;
      close?.();
    };
  }, [documents, key]);

  return state;
}
