/**
 * The part that writes: watches the notes changed most recently and adds the missing
 * properties to the ones this device changed.
 *
 * **It reads the local replica, so it works offline.** An edit on this device lands in the
 * local row at once (stamped with this user and the device's clock) and the live query
 * sees it there; the property is spliced into the note locally and syncs with the rest.
 *
 * **Only this device's changes.** Every device a person has open sees the same rows
 * change, and two of them adding the same key at once would leave it in the note twice.
 * So a change counts only when this user made it and this window has focus — the device
 * being typed on — or, for a new note, when the row is still the one this device made
 * (`materialized_version: "local"`).
 *
 * **"New" lasts a moment.** A note is often filed a beat after it is made (the folder it
 * goes in is another note's edit), so a note stays new for {@link NEW_FOR_MS} and is
 * looked at again as that settles; "is inside note" can then match it.
 *
 * **Never a key the note has.** Checked on the row that triggered it and again, fresh,
 * just before each write — the splice would otherwise replace the value a person typed a
 * moment before.
 */

import type { DocumentRow, DocumentsApi, FilterJson, Unsubscribe } from "@kernel";

import { buildConditions, treeToWatch } from "../../_shared/conditions.js";
import { contextFrom, watchChildren, type ChildrenMap } from "../../_shared/conditions-children.js";
import { EXCLUDE_MACHINE_DOCUMENTS, isMachineDocument } from "../../_shared/machine-docs.js";

import { fieldValue, wanted, type AutoField } from "./fields.js";

/** How many of the most recently changed notes are watched: edits arrive one note at a time. */
const WATCHED = 25;
/** How long a note counts as new, and when it is looked at again inside that. */
export const NEW_FOR_MS = 15_000;
const RECHECK_MS = [1_500, 5_000, 12_000];
/** A note whose first change is this long after it was made is not being made now. */
const CREATED_WITHIN_MS = 60_000;

export interface WatcherOptions {
  readonly documents: Pick<DocumentsApi, "subscribe" | "query" | "get" | "splice">;
  readonly userId: string;
  readonly fields: () => readonly AutoField[];
  /** Is this the device being used right now? */
  readonly active: () => boolean;
  readonly warn: (message: string, cause?: unknown) => void;
}

export interface Watcher {
  /** The fields changed: watch the notes their conditions name. */
  refresh(): void;
  close(): void;
}

export function watch({ documents, userId, fields, active, warn }: WatcherOptions): Watcher {
  let closed = false;
  /** `updated_at` last handled, per note; the first result is the baseline, not acted on. */
  const seen = new Map<string, string>();
  let baseline = true;
  /** Notes made on this device, and when they were first seen. */
  const fresh = new Map<string, number>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  /** One run per note at a time; a change during one runs again after it. */
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
    // Conditions that build nothing match nothing: a half-made field must not touch every note.
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
        // Fresh, because the person may have typed the key since the row above.
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
      // Filed a moment after it was made: the new notes may match now.
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

/** Rows whose frontmatter may be written: live, readable, a person's. */
function usable(row: DocumentRow): boolean {
  return !row.deleted && !row.fm_parse_error && !isMachineDocument(row);
}

/** A note this user is making on this device right now. */
function madeHere(row: DocumentRow, userId: string, active: () => boolean): boolean {
  if (row.created_by !== userId) return false;
  const age = Date.parse(row.updated_at) - Date.parse(row.created_at);
  if (!(age >= 0 && age < CREATED_WITHIN_MS)) return false;
  return row.materialized_version === "local" || active();
}
