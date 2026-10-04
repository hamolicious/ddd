import { useEffect, useRef, useState } from "react";

import type {
  FilterJson,
  SearchWindow,
  SearchCompareOp,
  SearchCondition,
  SearchHitInfo,
  SearchLiteral,
  SearchPlanJson,
  Unsubscribe,
} from "@kernel";

import { MACHINE_KEY } from "./machine-docs.js";

export interface LiveSearchResult<Row> {
  readonly rows: readonly Row[];
  readonly total?: number;
  readonly nextCursor?: string;
  readonly hits?: Readonly<Record<string, SearchHitInfo>>;
}

export interface LiveSearchWatch<Row> {
  readonly result: LiveSearchResult<Row>;
  onChange(listener: (result: LiveSearchResult<Row>) => void): () => void;
  window(start: number, count: number): Promise<void>;
  close(): void;
}

export interface Watchable<Row> {
  plan(): SearchPlanJson;
  watch(options?: { readonly window?: SearchWindow }): Promise<LiveSearchWatch<Row>>;
}

export interface LiveSearchState<Row> {
  readonly rows: readonly Row[];
  readonly total: number;
  readonly hits: Readonly<Record<string, SearchHitInfo>>;
  readonly loading: boolean;
  readonly error?: string;
}

function stateOf<Row>(result: LiveSearchResult<Row>): LiveSearchState<Row> {
  return { rows: result.rows, total: result.total ?? result.rows.length, hits: result.hits ?? {}, loading: false };
}

const message = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function useLiveSearch<Row>(query: Watchable<Row> | undefined, window?: SearchWindow): LiveSearchState<Row> {
  const key = query === undefined ? "" : JSON.stringify(query.plan());
  const current = useRef(query);
  current.current = query;
  const watch = useRef<LiveSearchWatch<Row> | undefined>(undefined);
  const windowKey = window === undefined ? "" : `${window.start}:${window.count}`;
  const latestWindow = useRef(window);
  latestWindow.current = window;
  const [state, setState] = useState<LiveSearchState<Row>>({ rows: [], total: 0, hits: {}, loading: query !== undefined });

  useEffect(() => {
    const source = current.current;
    if (source === undefined) {
      setState({ rows: [], total: 0, hits: {}, loading: false });
      return undefined;
    }
    let live = true;
    let off: (() => void) | undefined;
    setState((previous) => ({ ...previous, loading: true }));
    void (async () => {
      try {
        const wanted = latestWindow.current;
        const opened = await source.watch(wanted === undefined ? undefined : { window: wanted });
        if (!live) {
          opened.close();
          return;
        }
        watch.current = opened;
        off = opened.onChange((result) => {
          if (live) setState(stateOf(result));
        });
        const now = latestWindow.current;
        if (now !== undefined && (now.start !== wanted?.start || now.count !== wanted?.count)) {
          await opened.window(now.start, now.count);
        }
        if (live) setState(stateOf(opened.result));
      } catch (cause) {
        if (live) setState({ rows: [], total: 0, hits: {}, loading: false, error: message(cause) });
      }
    })();
    return () => {
      live = false;
      off?.();
      watch.current?.close();
      watch.current = undefined;
    };
  }, [key]);

  useEffect(() => {
    const opened = watch.current;
    const wanted = latestWindow.current;
    if (opened === undefined || wanted === undefined) return;
    setState((previous) => ({ ...previous, loading: true }));
    void opened.window(wanted.start, wanted.count).then(
      () => setState(stateOf(opened.result)),
      (cause: unknown) => setState((previous) => ({ ...previous, error: message(cause) })),
    );
  }, [windowKey]);

  return state;
}

export function watchRows<Row>(
  query: Watchable<Row>,
  listener: (rows: readonly Row[]) => void,
  onError?: (error: unknown) => void,
): Unsubscribe {
  let closed = false;
  let close: (() => void) | undefined;
  void query.watch().then(
    (opened) => {
      if (closed) {
        opened.close();
        return;
      }
      listener(opened.result.rows);
      const off = opened.onChange((result) => listener(result.rows));
      close = () => {
        off();
        opened.close();
      };
    },
    (error: unknown) => onError?.(error),
  );
  return () => {
    closed = true;
    close?.();
  };
}

interface LooseExpression {
  (field: string, op: string, value?: unknown, options?: { readonly deep?: boolean }): SearchCondition;
  and(...conditions: readonly SearchCondition[]): SearchCondition;
  or(...conditions: readonly SearchCondition[]): SearchCondition;
  not(condition: SearchCondition): SearchCondition;
}

type Node = { readonly [key: string]: unknown };

function literalOf(value: unknown): SearchLiteral {
  if (value === "null" || value === null || value === undefined) return null;
  const node = value as Node;
  if ("str" in node) return node.str as string;
  if ("int" in node) return node.int as number;
  if ("float" in node) return node.float as number;
  if ("bool" in node) return node.bool as boolean;
  if ("date" in node) return { date: String(node.date) };
  return null;
}

const TEXT_OPS = { contains: "text_contains", starts_with: "text_starts_with", ends_with: "text_ends_with" } as const;

export function conditionOf<W>(expression: W, filter: FilterJson): SearchCondition {
  const w = expression as unknown as LooseExpression;
  const convert = (node: unknown): SearchCondition => {
    if (node === "all") return w.and();
    if (node === "none") return w.or();
    const [kind, body] = Object.entries(node as Node)[0] ?? ["all", {}];
    const b = body as Node;
    switch (kind) {
      case "and":
        return w.and(...(b as unknown as readonly unknown[]).map(convert));
      case "or":
        return w.or(...(b as unknown as readonly unknown[]).map(convert));
      case "not":
        return w.not(convert(b));
      case "cmp":
        return w(String(b.field), String(b.op), literalOf(b.value));
      case "in":
        return w(String(b.field), "in", (b.values as readonly unknown[]).map(literalOf));
      case "contains":
        return w(String(b.field), "contains", literalOf(b.value));
      case "contains_any":
        return w(String(b.field), "contains_any", (b.values as readonly unknown[]).map(literalOf));
      case "any":
      case "every":
        return w(String(b.field), kind, [b.op as SearchCompareOp, literalOf(b.value)]);
      case "missing":
      case "exists":
      case "is_null":
        return w(String(b.field), kind);
      case "text":
        return w(String(b.field), TEXT_OPS[b.mode as keyof typeof TEXT_OPS], String(b.value));
      case "child_of":
        return w(String(b.field ?? "id"), "child_of", String(b.of), { deep: b.deep === true });
      case "parent_of":
        return w(String(b.field ?? "id"), "parent_of", String(b.of));
      default:
        return w.and();
    }
  };
  return convert(filter);
}

export function notMachine<W>(expression: W): SearchCondition {
  const w = expression as unknown as LooseExpression;
  return w.not(w(`fm.${MACHINE_KEY}`, "eq", true));
}
