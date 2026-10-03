import type { DocumentId, DocumentRow, Kernel, Unsubscribe } from "@kernel";

import { watchRows } from "../../_shared/live-search.js";

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

const CONTENT_BATCH = 500;

let stop: Unsubscribe | undefined;

interface LightRow {
  readonly id: string;
  readonly title: string;
  readonly materialized_version: string;
  readonly updated_at: string;
  readonly deleted: boolean;
  readonly words: number;
  readonly characters: number;
}

const stampOf = (row: LightRow): string =>
  [row.materialized_version, row.updated_at, row.deleted, row.words, row.characters, row.title].join("\u0000");

export default function activate(kernel: Kernel): void {
  const stamps = new Map<string, string>();
  let queue: Promise<void> = Promise.resolve();
  let first = true;

  const take = async (rows: readonly LightRow[]): Promise<void> => {
    const present = new Set(rows.map((row) => row.id));
    const changed = rows.filter((row) => stamps.get(row.id) !== stampOf(row)).map((row) => row.id);
    const full: DocumentRow[] = [];
    for (let at = 0; at < changed.length; at += CONTENT_BATCH) {
      const ids = changed.slice(at, at + CONTENT_BATCH);
      const page = await kernel.search.from().trash("all").where("id", "in", ids).withContent().run();
      full.push(...(page.rows as readonly DocumentRow[]));
    }
    const fetched = new Set(changed);
    for (const row of rows) if (fetched.has(row.id)) stamps.set(row.id, stampOf(row));
    for (const id of [...stamps.keys()]) if (!present.has(id)) stamps.delete(id);
    if (index.update(full, present)) {
      version = index.version;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          kernel.log.warn("an index listener threw", error);
        }
      }
    }
    if (first) {
      first = false;
      settle?.resolve();
    }
  };

  stop = watchRows(
    kernel.search
      .from()
      .trash("all")
      .select("id", "title", "materialized_version", "updated_at", "deleted", "words", "characters"),
    (rows) => {
      queue = queue.then(() => take(rows)).catch((error: unknown) => kernel.log.error("the workspace could not be indexed", error));
    },
    (error: unknown) => {
      kernel.log.error("the workspace could not be indexed", error);
      settle?.reject(error);
    },
  );
}

export function deactivate(): void {
  stop?.();
  stop = undefined;
}
