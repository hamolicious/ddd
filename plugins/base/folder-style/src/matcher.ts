import type { DocumentsApi, FilterJson, Unsubscribe } from "@kernel";

import { buildConditions, treeToWatch } from "../../_shared/conditions.js";
import { contextFrom, watchChildren, type ChildrenMap } from "../../_shared/conditions-children.js";

import type { FolderStyle, Rule } from "./styles.js";

interface Watch {
  readonly key: string;
  ids: ReadonlySet<string>;
  readonly close: () => void;
}

export interface RuleMatcher {
  set(rules: readonly Rule[]): void;
  matched(id: string): readonly FolderStyle[];
  close(): void;
}

const NONE: ReadonlySet<string> = new Set();

export function ruleMatcher(
  documents: Pick<DocumentsApi, "subscribe">,
  onChange: () => void,
  onError: (cause: unknown) => void,
): RuleMatcher {
  let rules: readonly Rule[] = [];
  let watches: (Watch | undefined)[] = [];
  let children: ChildrenMap = new Map();
  let parentsKey = "";
  let stopChildren: Unsubscribe = () => {};

  const watch = (key: string, filter: FilterJson): Watch => {
    let closed = false;
    let stop: (() => void) | undefined;
    const entry: Watch = {
      key,
      ids: NONE,
      close: () => {
        closed = true;
        stop?.();
      },
    };
    void documents.subscribe({ filter }).then(
      (subscription) => {
        if (closed) {
          subscription.close();
          return;
        }
        const take = (rows: readonly { id: string }[]): void => {
          entry.ids = new Set(rows.map((row) => row.id));
          onChange();
        };
        take(subscription.result.rows);
        const off = subscription.onChange((result) => take(result.rows));
        stop = () => {
          off();
          subscription.close();
        };
      },
      (cause: unknown) => onError(cause),
    );
    return entry;
  };

  const rebuild = (): void => {
    const context = contextFrom(children);
    let changed = false;
    const next = rules.map((rule, index) => {
      const filter = buildConditions(rule.when, context);
      const key = JSON.stringify(filter ?? null);
      const current = watches[index];
      if (current?.key === key) return current;
      current?.close();
      changed = true;
      return filter === undefined ? undefined : watch(key, filter);
    });
    for (const extra of watches.slice(rules.length)) {
      extra?.close();
      changed = true;
    }
    watches = next;
    if (changed) onChange();
  };

  return {
    set(next) {
      rules = next;
      const wanted = rules.map((rule) => treeToWatch(rule.when));
      const parents = wanted.includes("all")
        ? "all"
        : [...new Set(wanted.flatMap((ids) => (ids === "all" ? [] : ids)))].sort();
      const key = parents === "all" ? parents : parents.join("\n");
      if (key !== parentsKey) {
        parentsKey = key;
        stopChildren();
        stopChildren = watchChildren(documents, parents, (map) => {
          children = map;
          rebuild();
        });
      }
      rebuild();
    },
    matched(id) {
      const styles: FolderStyle[] = [];
      rules.forEach((rule, index) => {
        if (watches[index]?.ids.has(id)) styles.push(rule.style);
      });
      return styles;
    },
    close() {
      stopChildren();
      for (const entry of watches) entry?.close();
      watches = [];
    },
  };
}
