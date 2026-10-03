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
import { ProjectionHost } from "../search/backend.js";
import { serializeSearchError } from "../search/errors.js";

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const index = new WasmEngineIndex({
  persistence:
    typeof indexedDB === "undefined" ? new MemorySearchPersistence() : new IdbSearchPersistence(),
});

const projection = new ProjectionHost({
  persistent: typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function",
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
      projection.close();
      return await index.close();
    case "projection.open":
      return await projection.open();
    case "projection.status":
      return await projection.status();
    case "projection.sync":
      return await projection.sync(request.rows, request.first, request.last);
    case "projection.apply":
      return await projection.apply(request.rows, request.purged);
    case "projection.select":
      return await projection.select(request.sql);
    case "projection.run":
      return await projection.run(request.plan);
    case "projection.wipe":
      return await projection.wipe();
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
        detail: serializeSearchError(error),
      };
      scope.postMessage(response);
    },
  );
});
