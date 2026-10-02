import { useEffect, useMemo, useState } from "react";

import type { DocumentsApi, FilterJson, Unsubscribe } from "@kernel";

import { CHILDREN_FIELD, type ConditionContext } from "./conditions.js";

export type ChildrenMap = ReadonlyMap<string, readonly string[]>;

export function childrenIn(plugins: unknown): readonly string[] {
  const section = (plugins as { folders?: { children?: unknown } } | undefined)?.folders;
  const children = section?.children;
  return Array.isArray(children) ? children.filter((child): child is string => typeof child === "string") : [];
}

export function contextFrom(children: ChildrenMap): ConditionContext {
  return { childrenOf: (id) => children.get(id) };
}

export function watchChildren(
  documents: Pick<DocumentsApi, "subscribe">,
  ids: readonly string[] | "all",
  listener: (children: ChildrenMap) => void,
): Unsubscribe {
  if (ids.length === 0) {
    listener(new Map());
    return () => {};
  }
  const filter: FilterJson =
    ids === "all"
      ? { exists: { field: CHILDREN_FIELD } }
      : { in: { field: "id", values: ids.map((id) => ({ str: id })) } };
  let closed = false;
  let close: (() => void) | undefined;
  void documents.subscribe({ filter }).then(
    (subscription) => {
      if (closed) {
        subscription.close();
        return;
      }
      const take = (rows: readonly { id: string; plugins: unknown }[]): void =>
        listener(new Map(rows.map((row) => [row.id, childrenIn(row.plugins)])));
      take(subscription.result.rows);
      const off = subscription.onChange((result) => take(result.rows));
      close = () => {
        off();
        subscription.close();
      };
    },
    () => listener(new Map()),
  );
  return () => {
    closed = true;
    close?.();
  };
}

export function useConditionContext(
  documents: Pick<DocumentsApi, "subscribe">,
  ids: readonly string[] | "all",
): ConditionContext {
  const key = ids === "all" ? ids : ids.join("\n");
  const [children, setChildren] = useState<ChildrenMap>(() => new Map());
  useEffect(() => watchChildren(documents, ids, setChildren), [documents, key]);
  return useMemo(() => contextFrom(children), [children]);
}
