/**
 * `indexer` — indexes over the local projection, for other plugins to read.
 *
 * ## API (`plugin:indexer`)
 *
 * The old `lm/workspace-index` service, member for member, as named exports:
 *
 * - `ready: Promise<void>` — resolves after the first full build; rejects if the
 *   projection could not be read.
 * - `version: number` — a live binding; goes up by one each time any index changes.
 * - `stats(scope?)` → `WorkspaceStats`
 * - `fmFields(scope?)` → `readonly FmField[]`
 * - `fmValues(key, scope?)` → `readonly FmValueCount[]`
 * - `documents(scope?)` → `readonly IndexedDocument[]`
 * - `connections(id)` → `NoteConnections`
 * - `subscribe(listener)` → `Unsubscribe`: called after every change to any index.
 * - Types: `WorkspaceIndex` (all of the above as one type — the module namespace
 *   satisfies it), `PropertyKind`, `ConnectionKind`, `TargetState`, `Connection`,
 *   `OutgoingConnection`, `NoteConnections`, `IndexedDocument`, `FmField`, `FmValueCount`,
 *   `WorkspaceStats`, `IndexScope`, `FieldScope`.
 *
 * - `extract.ts` — what one document contributes: fields, connections, words, tasks.
 * - `workspace-index.ts` — the indexes, re-extracting only what changed.
 *
 * One live query over every document, Trash included, and the index is brought level
 * with its result each time it changes: on this device's own edits and on everything the
 * feed delivers, online or off. Nothing is written — each client indexes for itself — so
 * nothing lands in a document's history and there is no server write cap to stay under.
 *
 * The index lives at module scope, so a read before `activate` answers like one before
 * `ready`: an empty workspace. No UI and no dependencies.
 */

import type { DocumentId, DocumentQueryResult, Kernel, QuerySubscription, Unsubscribe } from "@kernel";

import type {
  FieldScope,
  FmField,
  FmValueCount,
  IndexedDocument,
  IndexScope,
  NoteConnections,
  WorkspaceStats,
} from "./api.js";
import { WorkspaceIndex as Indexes } from "./workspace-index.js";

export type {
  Connection,
  ConnectionKind,
  FieldScope,
  FmField,
  FmValueCount,
  IndexedDocument,
  IndexScope,
  NoteConnections,
  OutgoingConnection,
  PropertyKind,
  TargetState,
  WorkspaceIndex,
  WorkspaceStats,
} from "./api.js";

const index = new Indexes();
const listeners = new Set<() => void>();

let settle: { resolve(): void; reject(error: unknown): void } | undefined;

/** Resolves after the first full build; rejects if the projection could not be read. */
export const ready: Promise<void> = new Promise<void>((resolve, reject) => {
  settle = { resolve, reject };
});
// A caller that never awaits `ready` must not turn a failed build into an unhandled rejection.
ready.catch(() => {});

/** Goes up by one each time any index changes. A live binding: read it, don't copy it. */
export let version = index.version;

/** Content stats are for human documents unless `includeMachine`; `documents` always counts both. */
export function stats(scope?: IndexScope): WorkspaceStats {
  return index.stats(scope);
}

/** Every frontmatter key in use in any live document, nested keys included; most-used first. */
export function fmFields(scope?: FieldScope): readonly FmField[] {
  return index.fmFields(scope);
}

/** The values one key (dotted for a nested one) holds, most-used first. */
export function fmValues(key: string, scope?: FieldScope): readonly FmValueCount[] {
  return index.fmValues(key, scope);
}

/** Every live document, by title; machine-owned ones only with `includeMachine`. */
export function documents(scope?: IndexScope): readonly IndexedDocument[] {
  return index.documents(scope);
}

/** Outgoing and incoming connections of one document. An unknown id has none. */
export function connections(id: DocumentId): NoteConnections {
  return index.connections(id);
}

/** Called after every change to any index. */
export function subscribe(listener: () => void): Unsubscribe {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let subscription: QuerySubscription | undefined;

export default function activate(kernel: Kernel): void {
  const apply = (result: DocumentQueryResult): void => {
    if (!index.sync(result.rows)) return;
    version = index.version;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        kernel.log.warn("an index listener threw", error);
      }
    }
  };

  kernel.documents.subscribe({ includeDeleted: true }).then(
    (opened) => {
      subscription = opened;
      apply(opened.result);
      opened.onChange(apply);
      settle?.resolve();
    },
    (error: unknown) => {
      kernel.log.error("the workspace could not be indexed", error);
      settle?.reject(error);
    },
  );
}

export function deactivate(): void {
  subscription?.close();
  subscription = undefined;
}
