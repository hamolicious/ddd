import type { DocumentRow, DocumentsApi, FilterJson, Unsubscribe } from "@kernel";

import { buildConditions, treeToWatch } from "../../_shared/conditions.js";
import { contextFrom, watchChildren, type ChildrenMap } from "../../_shared/conditions-children.js";
import { EXCLUDE_MACHINE_DOCUMENTS, isMachineDocument } from "../../_shared/machine-docs.js";

import { fieldValue, wanted, type AutoField } from "./fields.js";

const WATCHED = 25;
export const NEW_FOR_MS = 15_000;
const RECHECK_MS = [1_500, 5_000, 12_000];
const CREATED_WITHIN_MS = 60_000;

export interface WatcherOptions {
  readonly documents: Pick<DocumentsApi, "subscribe" | "query" | "get" | "splice">;
  readonly userId: string;
  readonly fields: () => readonly AutoField[];
  readonly active: () => boolean;
  readonly warn: (message: string, cause?: unknown) => void;
}

export interface Watcher {
  refresh(): void;
  close(): void;
}

export function watch({ documents, userId, fields, active, warn }: WatcherOptions): Watcher {
  let closed = false;
  const seen = new Map<string, string>();
  let baseline = true;
  const fresh = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const running = new Set<string>();
  const again = new Set<string>();

  let children: ChildrenMap = new Map();
  let treeKey = "";
  let stopTree: Unsubscribe = () => {};

  const isFresh = (id: string): boolean => {
    const since = fresh.get(id);
    if (since === undefined) return false;
    if (Date.now() - since < NEW_FOR_MS) return true;
    fresh.delete(id);
    return false;
  };

  const matches = async (field: AutoField, id: string): Promise<boolean> => {
    if (field.when.clauses.length === 0) return true;
    const filter = buildConditions(field.when, contextFrom(children));
    if (filter === undefined) return false;
    const only: FilterJson = { cmp: { field: "id", op: "eq", value: { str: id } } };
    const result = await documents.query({ filter: { and: [filter, only] }, limit: 1 });
    return result.total > 0;
  };

  const fill = async (id: string): Promise<void> => {
    if (running.has(id)) {
      again.add(id);
      return;
    }
    running.add(id);
    try {
      const row = await documents.get(id);
      if (row === undefined || !usable(row)) return;
      const now = new Date();
      for (const field of wanted(fields(), row.fm, isFresh(id))) {
        if (closed || !(await matches(field, id))) continue;
        const current = await documents.get(id);
        if (current === undefined || !usable(current) || field.key.trim() in current.fm) continue;
        await documents.splice.setFrontmatterValue(id, field.key.trim(), fieldValue(field.value, now));
      }
    } catch (cause) {
      warn(`could not add properties to ${id}`, cause);
    } finally {
      running.delete(id);
      if (again.delete(id) && !closed) void fill(id);
    }
  };

  const later = (id: string): void => {
    for (const delay of RECHECK_MS) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closed && isFresh(id)) void fill(id);
      }, delay);
      timers.add(timer);
    }
  };

  const take = (rows: readonly DocumentRow[]): void => {
    if (closed) return;
    const first = baseline;
    baseline = false;
    for (const row of rows) {
      const before = seen.get(row.id);
      if (before === row.updated_at) continue;
      seen.set(row.id, row.updated_at);
      if (first || row.updated_by !== userId) continue;
      if (before === undefined && madeHere(row, userId, active)) {
        fresh.set(row.id, Date.now());
        later(row.id);
      } else if (!active()) {
        continue;
      }
      void fill(row.id);
    }
  };

  let stopRecent: (() => void) | undefined;
  void documents
    .subscribe({ filter: EXCLUDE_MACHINE_DOCUMENTS, sort: [{ field: "updated_at", direction: "desc" }], limit: WATCHED })
    .then(
      (subscription) => {
        if (closed) {
          subscription.close();
          return;
        }
        take(subscription.result.rows);
        const off = subscription.onChange((result) => take(result.rows));
        stopRecent = () => {
          off();
          subscription.close();
        };
      },
      (cause: unknown) => warn("could not watch for changed notes", cause),
    );

  const refresh = (): void => {
    const wantedTrees = fields().map((field) => treeToWatch(field.when));
    const ids = wantedTrees.includes("all")
      ? "all"
      : [...new Set(wantedTrees.flatMap((each) => (each === "all" ? [] : each)))].sort();
    const key = ids === "all" ? ids : ids.join("\n");
    if (key === treeKey) return;
    treeKey = key;
    stopTree();
    stopTree = watchChildren(documents, ids, (map) => {
      children = map;
      for (const id of fresh.keys()) if (isFresh(id)) void fill(id);
    });
  };
  refresh();

  return {
    refresh,
    close() {
      closed = true;
      stopRecent?.();
      stopTree();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

function usable(row: DocumentRow): boolean {
  return !row.deleted && !row.fm_parse_error && !isMachineDocument(row);
}

function madeHere(row: DocumentRow, userId: string, active: () => boolean): boolean {
  if (row.created_by !== userId) return false;
  const age = Date.parse(row.updated_at) - Date.parse(row.created_at);
  if (!(age >= 0 && age < CREATED_WITHIN_MS)) return false;
  return row.materialized_version === "local" || active();
}
