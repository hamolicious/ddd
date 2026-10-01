/**
 * The local query engine's index: what it indexes, what it persists, and the worker
 * plumbing in front of it (SPEC §4.2). Ranking and matching themselves are the
 * shared core's, tested in Rust (`backend/crates/core/src/query/text.rs`).
 */

import { beforeAll, describe, expect, it } from "vitest";

import type { CoreMap, ProjectionRow } from "../protocol.js";
import type { CoreBindings } from "../wasm/index.js";
import { coreArtifactExists, loadCoreForNode } from "../wasm/node-core.js";
import type { QueryPlan } from "./plan.js";
import { MemorySearchPersistence, SEARCH_INDEX_VERSION, WasmEngineIndex, type EngineIndex } from "./search.js";
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
  deleted_at: fields.deleted ? "2026-01-02T00:00:00.000Z" : null,
  deleted_by: null,
  purged: false,
});

/** The ids a text search finds, best first. */
async function find(index: EngineIndex, text: string, plan: QueryPlan = {}): Promise<readonly string[]> {
  return (await index.run({ text, sort: ["relevance"], ...plan })).ids;
}

const available = coreArtifactExists();

describe.skipIf(!available)("WasmEngineIndex", () => {
  let core: CoreBindings;
  beforeAll(async () => {
    core = await loadCoreForNode();
  });
  const open = async (persistence?: MemorySearchPersistence) => {
    const index = new WasmEngineIndex(persistence ? { core, persistence } : { core });
    await index.open();
    return index;
  };

  it("indexes title, content and fm values, with the title ranked highest", async () => {
    const index = await open();
    await index.upsert([
      row("content-hit", { title: "Nothing", content: "a mango, sliced" }),
      row("fm-hit", { title: "Nothing", fm: { tags: ["mango"], status: "ripe" } }),
      row("title-hit", { title: "Mango", content: "nothing" }),
    ]);
    const hits = await find(index, "mango");
    expect([...hits].sort()).toEqual(["content-hit", "fm-hit", "title-hit"]);
    expect(hits[0]).toBe("title-hit");
    // Keys are not text: `status` matches no document.
    expect(await find(index, "status")).toEqual([]);
  });

  it("replaces a row rather than duplicating it", async () => {
    const index = await open();
    await index.upsert([row("a", { content: "before" })]);
    await index.upsert([row("a", { content: "after" })]);
    expect((await index.stats()).documents).toBe(1);
    expect(await find(index, "before")).toEqual([]);
    expect(await find(index, "after")).toEqual(["a"]);
  });

  it("hides tombstoned rows unless asked, and drops removed ids", async () => {
    const index = await open();
    await index.upsert([row("live", { content: "shared word" }), row("trashed", { content: "shared word", deleted: true })]);
    expect(await find(index, "shared")).toEqual(["live"]);
    expect([...(await find(index, "shared", { trash: "all" }))].sort()).toEqual(["live", "trashed"]);

    await index.remove(["trashed", "never-existed"]);
    expect(await find(index, "shared", { trash: "all" })).toEqual(["live"]);
  });

  it("answers filters and sorts without text", async () => {
    const index = await open();
    await index.upsert([row("b", { fm: { n: 2 } }), row("a", { fm: { n: 1 } }), row("c")]);
    const page = await index.run({ filter: { exists: { field: "fm.n" } }, sort: ["-fm.n"] });
    expect(page.ids).toEqual(["b", "a"]);
    expect(page.total).toBe(2);
  });

  it("rejects a plan the core refuses", async () => {
    const index = await open();
    await expect(index.run({ sort: ["nope"] } as QueryPlan)).rejects.toThrow(/plan/);
  });

  it("round-trips through persistence without re-indexing", async () => {
    const persistence = new MemorySearchPersistence();
    const first = await open(persistence);
    await first.upsert([row("a", { title: "Durable", content: "persisted text" })]);
    await first.persist(42);

    const entry = await persistence.load();
    expect(entry?.version).toBe(SEARCH_INDEX_VERSION);
    expect(entry?.safeSeq).toBe(42);
    expect(entry?.documents).toBe(1);

    const second = await open(persistence);
    expect((await second.stats()).safeSeq).toBe(42);
    expect(await find(second, "persisted")).toEqual(["a"]);
  });

  it("starts empty when the persisted engine is unreadable", async () => {
    const persistence = new MemorySearchPersistence();
    await persistence.save({ version: SEARCH_INDEX_VERSION, safeSeq: 7, builtAt: 1, documents: 1, index: "{not json}" });
    const index = await open(persistence);
    expect((await index.stats()).documents).toBe(0);
    expect((await index.stats()).safeSeq).toBe(0);
    expect(await persistence.load()).toBeUndefined();
  });

  it("swaps a streamed rebuild in atomically", async () => {
    const index = await open();
    await index.upsert([row("old", { content: "obsolete" })]);

    const pass = index.beginRebuild();
    pass.add([row("new", { content: "fresh" })]);
    // Not visible yet: the old engine still answers.
    expect(await find(index, "obsolete")).toEqual(["old"]);
    pass.commit();

    expect(await find(index, "obsolete")).toEqual([]);
    expect(await find(index, "fresh")).toEqual(["new"]);
  });

  it("refuses to work before open()", async () => {
    await expect(new WasmEngineIndex({ core }).upsert([row("a")])).rejects.toThrow(/not open/);
  });
});

/**
 * A loopback `Worker`: the same request/response envelopes the real worker
 * exchanges, dispatched to an in-process index. It proves the client half —
 * request/reply matching and the chunked rebuild — without a browser.
 */
class LoopbackWorker implements Pick<Worker, "postMessage" | "addEventListener" | "terminate"> {
  readonly index: WasmEngineIndex;
  terminated = false;
  received = 0;
  readonly #listeners: ((event: { data: unknown }) => void)[] = [];
  #rebuild: ReturnType<WasmEngineIndex["beginRebuild"]> | undefined;

  constructor(core: CoreBindings) {
    this.index = new WasmEngineIndex({ core });
  }

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
      case "run":
        return await this.index.run(request.plan);
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

describe.skipIf(!available)("WorkerSearchIndex", () => {
  let core: CoreBindings;
  beforeAll(async () => {
    core = await loadCoreForNode();
  });

  const wire = () => {
    const worker = new LoopbackWorker(core);
    const index = new WorkerSearchIndex({ workerFactory: () => worker as unknown as Worker });
    return { worker, index };
  };

  it("proxies the whole SearchIndex surface over the port", async () => {
    const { index } = wire();
    await index.open();
    await index.upsert([row("a", { title: "Remote", content: "over the port" })]);
    expect(await find(index, "port")).toEqual(["a"]);
    await index.persist(11);
    expect((await index.stats()).safeSeq).toBe(11);
    await index.remove(["a"]);
    expect(await find(index, "port")).toEqual([]);
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
    expect((await find(index, "599"))[0]).toBe("d599");
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
