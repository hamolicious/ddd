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

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const index = new WasmEngineIndex({
  persistence:
    typeof indexedDB === "undefined" ? new MemorySearchPersistence() : new IdbSearchPersistence(),
});

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
