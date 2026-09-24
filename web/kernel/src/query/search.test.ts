/**
 * The local full-text index: what it indexes, what it persists, and the worker
 * plumbing in front of it (SPEC §4.2).
 */

import { describe, expect, it } from "vitest";

import type { CoreMap, ProjectionRow } from "../protocol.js";
import {
  MemorySearchPersistence,
  MiniSearchIndex,
  SEARCH_INDEX_VERSION,
  indexDocument,
} from "./search.js";
import type {
  SearchRequestEnvelope,
  SearchResponseEnvelope,
  SearchResponseValue,
} from "./search-protocol.js";
import { WorkerSearchIndex } from "./worker-search.js";

const row = (
  id: string,
  fields: { title?: string; content?: string; fm?: CoreMap; deleted?: boolean } = {},
): ProjectionRow => ({
  id,
  title: fields.title ?? id,
  content: fields.content ?? "",
  fm: fields.fm ?? {},
  plugins: {},
  fm_parse_error: false,
  materialized_version: "v1",
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  updated_by: null,
  deleted: fields.deleted ?? false,
  deleted_at: null,
  deleted_by: null,
  purged: false,
});

const ids = (hits: readonly { id: string }[]) => hits.map((hit) => hit.id).sort();

describe("indexDocument", () => {
  it("flattens fm to its scalar leaves so tags and paths are searchable", () => {
    const document = indexDocument(
      row("a", { fm: { path: "home/lists", tags: ["work", "urgent"], nested: { k: 42 }, nothing: null } }),
    );
    // Key order (nested, nothing, path, tags), values only, nulls dropped.
    expect(document.fm).toBe("42 home/lists work urgent");
  });

  it("carries the tombstone flag as a stored field, not as text", () => {
    expect(indexDocument(row("a", { deleted: true })).deleted).toBe(true);
  });
});

describe("MiniSearchIndex", () => {
  it("indexes title, content and fm, with title ranked highest", async () => {
    const index = new MiniSearchIndex();
    await index.open();
    await index.upsert([
      row("title-hit", { title: "Mango", content: "nothing" }),
      row("content-hit", { title: "Nothing", content: "a mango, sliced" }),
      row("fm-hit", { title: "Nothing", fm: { tags: ["mango"] } }),
    ]);
    const hits = await index.search("mango");
    expect(ids(hits)).toEqual(["content-hit", "fm-hit", "title-hit"]);
    expect(hits[0]?.id).toBe("title-hit");
  });

  it("replaces a row rather than duplicating it", async () => {
    const index = new MiniSearchIndex();
    await index.open();
    await index.upsert([row("a", { content: "before" })]);
    await index.upsert([row("a", { content: "after" })]);
    expect((await index.stats()).documents).toBe(1);
    expect(await index.search("before")).toEqual([]);
    expect(ids(await index.search("after"))).toEqual(["a"]);
  });

  it("hides tombstoned rows unless asked, and drops removed ids", async () => {
    const index = new MiniSearchIndex();
    await index.open();
    await index.upsert([row("live", { content: "shared word" }), row("trashed", { content: "shared word", deleted: true })]);
    expect(ids(await index.search("shared"))).toEqual(["live"]);
    expect(ids(await index.search("shared", { includeDeleted: true }))).toEqual(["live", "trashed"]);

    await index.remove(["trashed", "never-existed"]);
    expect(ids(await index.search("shared", { includeDeleted: true }))).toEqual(["live"]);
  });

  it("returns nothing for an empty query instead of everything", async () => {
    const index = new MiniSearchIndex();
    await index.open();
    await index.upsert([row("a", { content: "text" })]);
    expect(await index.search("   ")).toEqual([]);
  });

  it("round-trips through persistence without re-tokenizing", async () => {
    const persistence = new MemorySearchPersistence();
    const first = new MiniSearchIndex({ persistence });
    await first.open();
    await first.upsert([row("a", { title: "Durable", content: "persisted text" })]);
    await first.persist(42);

    const entry = await persistence.load();
    expect(entry?.version).toBe(SEARCH_INDEX_VERSION);
    expect(entry?.safeSeq).toBe(42);
    expect(entry?.index.length ?? 0).toBeGreaterThan(0);

    const second = new MiniSearchIndex({ persistence });
    await second.open();
    expect((await second.stats()).safeSeq).toBe(42);
    expect(ids(await second.search("persisted"))).toEqual(["a"]);
  });

  it("starts empty when the persisted index is unreadable", async () => {
    const persistence = new MemorySearchPersistence();
    await persistence.save({
      version: SEARCH_INDEX_VERSION,
      safeSeq: 7,
      builtAt: 1,
      documents: 1,
      index: "{not json}",
    });
    const index = new MiniSearchIndex({ persistence });
    await index.open();
    expect((await index.stats()).documents).toBe(0);
    expect((await index.stats()).safeSeq).toBe(0);
    expect(await persistence.load()).toBeUndefined();
  });

  it("swaps a streamed rebuild in atomically", async () => {
    const index = new MiniSearchIndex();
    await index.open();
    await index.upsert([row("old", { content: "obsolete" })]);

    const pass = index.beginRebuild();
    pass.add([row("new", { content: "fresh" })]);
    // Not visible yet: the old index still answers.
    expect(ids(await index.search("obsolete"))).toEqual(["old"]);
    pass.commit();

    expect(await index.search("obsolete")).toEqual([]);
    expect(ids(await index.search("fresh"))).toEqual(["new"]);
  });

  it("refuses to work before open()", async () => {
    await expect(new MiniSearchIndex().upsert([row("a")])).rejects.toThrow(/not open/);
  });
});

/**
 * A loopback `Worker`: the same request/response envelopes the real worker
 * exchanges, dispatched to an in-process index. It proves the client half —
 * request/reply matching and the chunked rebuild — without a browser.
 */
class LoopbackWorker implements Pick<Worker, "postMessage" | "addEventListener" | "terminate"> {
  readonly index = new MiniSearchIndex();
  terminated = false;
  received = 0;
  readonly #listeners: ((event: { data: unknown }) => void)[] = [];
  #rebuild: ReturnType<MiniSearchIndex["beginRebuild"]> | undefined;

  postMessage(message: unknown): void {
    const envelope = message as SearchRequestEnvelope;
    this.received += 1;
    void this.#handle(envelope).then(
      (value) => this.#emit({ id: envelope.id, ok: true, value: value as SearchResponseValue }),
      (error: unknown) => this.#emit({ id: envelope.id, ok: false, error: String(error) }),
    );
  }

  addEventListener(type: string, listener: unknown): void {
    if (type === "message") this.#listeners.push(listener as (event: { data: unknown }) => void);
  }

  terminate(): void {
    this.terminated = true;
  }

  async #handle(envelope: SearchRequestEnvelope): Promise<unknown> {
    const request = envelope.request;
    switch (request.op) {
      case "open":
        return await this.index.open();
      case "upsert":
        return await this.index.upsert(request.rows);
      case "remove":
        return await this.index.remove(request.ids);
      case "search":
        return await this.index.search(request.query, request.options);
      case "persist":
        return await this.index.persist(request.safeSeq);
      case "stats":
        return await this.index.stats();
      case "rebuild": {
        if (request.first || !this.#rebuild) this.#rebuild = this.index.beginRebuild();
        if (request.rows.length > 0) this.#rebuild.add(request.rows);
        if (request.last) {
          this.#rebuild.commit();
          this.#rebuild = undefined;
        }
        return undefined;
      }
      case "close":
        return await this.index.close();
    }
  }

  #emit(response: SearchResponseEnvelope): void {
    for (const listener of this.#listeners) listener({ data: response });
  }
}

describe("WorkerSearchIndex", () => {
  const wire = () => {
    const worker = new LoopbackWorker();
    const index = new WorkerSearchIndex({ workerFactory: () => worker as unknown as Worker });
    return { worker, index };
  };

  it("proxies the whole SearchIndex surface over the port", async () => {
    const { index } = wire();
    await index.open();
    await index.upsert([row("a", { title: "Remote", content: "over the port" })]);
    expect(ids(await index.search("port"))).toEqual(["a"]);
    await index.persist(11);
    expect((await index.stats()).safeSeq).toBe(11);
    await index.remove(["a"]);
    expect(await index.search("port")).toEqual([]);
  });

  it("streams a rebuild in chunks instead of one giant message", async () => {
    const { worker, index } = wire();
    await index.open();
    const before = worker.received;
    const rows = Array.from({ length: 600 }, (_, i) => row(`d${i}`, { content: `body ${i}` }));
    await index.rebuild(
      (async function* () {
        yield* rows;
      })(),
    );
    // 250-row chunks: three messages, not one.
    expect(worker.received - before).toBe(3);
    expect((await index.stats()).documents).toBe(600);
    expect(ids(await index.search("body 599"))).toContain("d599");
  });

  it("skips the round trip for empty upserts and removals", async () => {
    const { worker, index } = wire();
    await index.open();
    const before = worker.received;
    await index.upsert([]);
    await index.remove([]);
    expect(worker.received).toBe(before);
  });

  it("terminates the worker on close and rejects in-flight work", async () => {
    const { worker, index } = wire();
    await index.open();
    await index.close();
    expect(worker.terminated).toBe(true);
  });
});
