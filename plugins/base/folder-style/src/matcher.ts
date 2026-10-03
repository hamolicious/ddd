import type { SearchApi } from "@kernel";

import { whereConditions } from "../../_shared/conditions.js";
import { watchRows } from "../../_shared/live-search.js";

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

export function ruleMatcher(search: SearchApi, onChange: () => void, onError: (cause: unknown) => void): RuleMatcher {
  let rules: readonly Rule[] = [];
  let watches: (Watch | undefined)[] = [];

  const queryFor = (rule: Rule) => {
    let empty = false;
    const query = search
      .from()
      .where((w) => {
        const condition = whereConditions(w, rule.when);
        empty = condition === undefined;
        return condition ?? w.and();
      })
      .select("id");
    return empty ? undefined : { query, key: JSON.stringify(query.plan()) };
  };

  const watch = (found: NonNullable<ReturnType<typeof queryFor>>): Watch => {
    const entry: Watch = { key: found.key, ids: NONE, close: () => stop() };
    const stop = watchRows(
      found.query,
      (rows) => {
        entry.ids = new Set(rows.map((row) => row.id));
        onChange();
      },
      onError,
    );
    return entry;
  };

  return {
    set(next) {
      rules = next;
      let changed = false;
      const updated = rules.map((rule, index) => {
        const current = watches[index];
        const found = queryFor(rule);
        if (current !== undefined && found !== undefined && current.key === found.key) return current;
        current?.close();
        changed = true;
        return found === undefined ? undefined : watch(found);
      });
      for (const extra of watches.slice(rules.length)) {
        extra?.close();
        changed = true;
      }
      watches = updated;
      if (changed) onChange();
    },
    matched(id) {
      const styles: FolderStyle[] = [];
      rules.forEach((rule, index) => {
        if (watches[index]?.ids.has(id)) styles.push(rule.style);
      });
      return styles;
    },
    close() {
      for (const entry of watches) entry?.close();
      watches = [];
    },
  };
}
