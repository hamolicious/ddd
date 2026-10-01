/**
 * The query worker (SPEC §4.2: "a full-text index … built in a Web Worker,
 * persisted and incrementally updated").
 *
 * Everything expensive about querying happens in here: the shared core's query
 * engine (wasm) holds the rows and their index, answers plans, and is serialized to
 * IndexedDB. The main thread only ever posts rows and plans in and takes ids out, so
 * a 5 000-document workspace never blocks a frame — including on the first run,
 * when there is nothing persisted yet.
 *
 * It is the worker *entry point*, not a module anyone imports: the pairing is
 * `worker-search.ts` (client) ⇄ this file (server), over
 * `search-protocol.ts`.
 */

import {
  IdbSearchPersistence,
  MemorySearchPersistence,
  WasmEngineIndex,
  type RebuildPass,
} from "./search.js";
import type {
  SearchRequestEnvelope,
  SearchResponseEnvelope,
  SearchResponseValue,
} from "./search-protocol.js";

/**
 * The bits of `DedicatedWorkerGlobalScope` this file uses. Spelled out because
 * the kernel typechecks against `lib.dom`, not `lib.webworker` — and mixing the
 * two makes `self.postMessage` ambiguous.
 */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const index = new WasmEngineIndex({
  persistence:
    typeof indexedDB === "undefined" ? new MemorySearchPersistence() : new IdbSearchPersistence(),
});

/** The in-flight streaming rebuild, if one is running. */
let rebuilding: RebuildPass | undefined;

async function handle(envelope: SearchRequestEnvelope): Promise<SearchResponseValue> {
  const request = envelope.request;
  switch (request.op) {
    case "open":
      return await index.open();
    case "upsert":
      return await index.upsert(request.rows);
    case "remove":
      return await index.remove(request.ids);
    case "run":
      return await index.run(request.plan);
    case "persist":
      return await index.persist(request.safeSeq);
    case "stats":
      return await index.stats();
    case "rebuild": {
      if (request.first || rebuilding === undefined) rebuilding = index.beginRebuild();
      if (request.rows.length > 0) rebuilding.add(request.rows);
      if (!request.last) return undefined;
      rebuilding.commit();
      rebuilding = undefined;
      return undefined;
    }
    case "close":
      return await index.close();
  }
}

scope.addEventListener("message", (event) => {
  const envelope = event.data as SearchRequestEnvelope;
  if (typeof envelope?.id !== "number" || typeof envelope.request?.op !== "string") return;
  void handle(envelope).then(
    (value) => {
      const response: SearchResponseEnvelope = { id: envelope.id, ok: true, value };
      scope.postMessage(response);
    },
    (error: unknown) => {
      const response: SearchResponseEnvelope = {
        id: envelope.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      scope.postMessage(response);
    },
  );
});
