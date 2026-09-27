/**
 * `indexer` — indexes over the local projection, for other plugins to read
 * (`_shared/indexer-api.ts` is the service it returns).
 *
 * - `extract.ts` — what one document contributes: fields, connections, words, tasks.
 * - `workspace-index.ts` — the indexes, re-extracting only what changed.
 *
 * One live query over every document, Trash included, and the index is brought level
 * with its result each time it changes: on this device's own edits and on everything the
 * feed delivers, online or off. Nothing is written — each client indexes for itself — so
 * nothing lands in a document's history and there is no server write cap to stay under.
 *
 * No UI and no dependencies: a plugin that wants the indexes declares
 * `"indexer": "^1.0"` and calls `kernel.services.require<IndexerApi>("indexer")`.
 */

import type { DocumentQueryResult, Kernel } from "@kernel";

import type { IndexerApi } from "../../_shared/indexer-api.js";

import { WorkspaceIndex } from "./workspace-index.js";

export default function activate(kernel: Kernel): IndexerApi {
  const index = new WorkspaceIndex();
  const listeners = new Set<() => void>();

  const apply = (result: DocumentQueryResult): void => {
    if (!index.sync(result.rows)) return;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        kernel.log.warn("an index listener threw", error);
      }
    }
  };

  const ready = kernel.documents.subscribe({ includeDeleted: true }).then((subscription) => {
    apply(subscription.result);
    subscription.onChange(apply);
  });
  // A caller that never awaits `ready` must not turn a failed build into an unhandled rejection.
  ready.catch((error: unknown) => kernel.log.error("the workspace could not be indexed", error));

  return {
    ready,
    get version() {
      return index.version;
    },
    stats: (scope) => index.stats(scope),
    fmFields: (scope) => index.fmFields(scope),
    fmValues: (key, scope) => index.fmValues(key, scope),
    connections: (id) => index.connections(id),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
