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

export const ready: Promise<void> = new Promise<void>((resolve, reject) => {
  settle = { resolve, reject };
});
ready.catch(() => {});

export let version = index.version;

export function stats(scope?: IndexScope): WorkspaceStats {
  return index.stats(scope);
}

export function fmFields(scope?: FieldScope): readonly FmField[] {
  return index.fmFields(scope);
}

export function fmValues(key: string, scope?: FieldScope): readonly FmValueCount[] {
  return index.fmValues(key, scope);
}

export function documents(scope?: IndexScope): readonly IndexedDocument[] {
  return index.documents(scope);
}

export function connections(id: DocumentId): NoteConnections {
  return index.connections(id);
}

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
