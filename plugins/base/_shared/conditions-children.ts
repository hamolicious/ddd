import { useEffect, useMemo, useState } from "react";

import type { SearchApi, Unsubscribe } from "@kernel";

import { CHILDREN_FIELD, type ConditionContext } from "./conditions.js";
import { watchRows } from "./live-search.js";

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
  search: SearchApi,
  ids: readonly string[] | "all",
  listener: (children: ChildrenMap) => void,
): Unsubscribe {
  if (ids.length === 0) {
    listener(new Map());
    return () => {};
  }
  const query =
    ids === "all"
      ? search.from().where(CHILDREN_FIELD, "exists")
      : search.from().where("id", "in", [...ids]);
  return watchRows(
    query.select("id", "plugins"),
    (rows) => listener(new Map(rows.map((row) => [row.id, childrenIn(row.plugins)]))),
    () => listener(new Map()),
  );
}

export function useConditionContext(search: SearchApi, ids: readonly string[] | "all"): ConditionContext {
  const key = ids === "all" ? ids : ids.join("\n");
  const [children, setChildren] = useState<ChildrenMap>(() => new Map());
  useEffect(() => watchChildren(search, ids, setChildren), [search, key]);
  return useMemo(() => contextFrom(children), [children]);
}
