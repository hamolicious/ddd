/**
 * The live half of `child_of` (`conditions.ts`): the children of the notes a set of
 * conditions names, read from their `%%% folders` lists and kept current. One live query
 * over just those notes — or, for a deep `child_of`, over every note that has children —
 * so a note filed into or out of one rebuilds the filter.
 */

import { useEffect, useMemo, useState } from "react";

import type { DocumentsApi, FilterJson, Unsubscribe } from "@kernel";

import { CHILDREN_FIELD, type ConditionContext } from "./conditions.js";

export type ChildrenMap = ReadonlyMap<string, readonly string[]>;

/** `plugins.folders.children` of a row, strings only. */
export function childrenIn(plugins: unknown): readonly string[] {
  const section = (plugins as { folders?: { children?: unknown } } | undefined)?.folders;
  const children = section?.children;
  return Array.isArray(children) ? children.filter((child): child is string => typeof child === "string") : [];
}

export function contextFrom(children: ChildrenMap): ConditionContext {
  return { childrenOf: (id) => children.get(id) };
}

/**
 * Calls `listener` with the children of each of `ids` (`"all"`: of every note that has
 * any) now and on every change; `[]` watches nothing. `treeToWatch` says which.
 */
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

/** {@link watchChildren} as a hook: the context to build `conditions` with. */
export function useConditionContext(
  documents: Pick<DocumentsApi, "subscribe">,
  ids: readonly string[] | "all",
): ConditionContext {
  const key = ids === "all" ? ids : ids.join("\n");
  const [children, setChildren] = useState<ChildrenMap>(() => new Map());
  useEffect(() => watchChildren(documents, ids, setChildren), [documents, key]);
  return useMemo(() => contextFrom(children), [children]);
}
