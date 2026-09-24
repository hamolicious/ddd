/**
 * `QueryEngine`: one-shot queries, live subscriptions, and search.
 *
 * Filter evaluation runs through the **real Wasm core** here — a fake evaluator
 * would let a TypeScript reimplementation of the DSL sneak in through the back
 * door, which is the one thing web/CONTRACTS.md forbids this area. The store is
 * in-memory (sanctioned by `store/projection-store.ts`); IndexedDB is the other
 * area's business and needs a browser.
 */

import { beforeAll, describe, expect, it } from "vitest";

import type { CoreMap, FeedRow } from "../protocol.js";
// The in-memory `ProjectionStore` the store area maintains for exactly this
// purpose. Using theirs rather than a second copy means one fake to keep honest.
import { MemoryProjectionStore } from "../store/testing.js";
import type { CoreBindings, FilterJson } from "../wasm/index.js";
import { coreArtifactExists, loadCoreForNode } from "../wasm/node-core.js";
import { QueryEngine } from "./index.js";
import { MemorySearchPersistence, MiniSearchIndex, SEARCH_INDEX_VERSION } from "./search.js";

let seq = 0;

function feedRow(
  id: string,
  fields: { title?: string; content?: string; fm?: CoreMap; deleted?: boolean; purged?: boolean } = {},
): FeedRow {
  seq += 1;
  const stamp = `2026-01-${String((seq % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
  return {
    seq,
    id,
    title: fields.title ?? id,
    content: fields.content ?? "",
    fm: fields.fm ?? {},
    plugins: {},
    fm_parse_error: false,
    materialized_version: `v${seq}`,
    created_at: stamp,
    created_by: null,
    updated_at: stamp,
    updated_by: null,
    deleted: fields.deleted ?? false,
    deleted_at: fields.deleted ? stamp : null,
    deleted_by: null,
    purged: fields.purged ?? false,
  };
}

/** Apply rows the way `FeedClient` does: rows plus the watermark, in one call. */
async function apply(store: MemoryProjectionStore, rows: readonly FeedRow[]): Promise<void> {
  const safeSeq = Math.max(0, ...rows.map((row) => row.seq));
  await store.applyRows(rows, {
    safeSeq,
    updatedAt: 0,
    coreSemanticsVersion: 1,
    bootstrapped: true,
  });
}

const openFilter = { cmp: { field: "fm.status", op: "eq", value: { str: "open" } } } as FilterJson;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const available = coreArtifactExists();

describe.skipIf(!available)("QueryEngine", () => {
  let core: CoreBindings;

  beforeAll(async () => {
    core = await loadCoreForNode();
  });

  it("filters with the Wasm core and sorts with compareRows", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [
      feedRow("b", { title: "Beta", fm: { status: "open", n: 2 } }),
      feedRow("a", { title: "Alpha", fm: { status: "open", n: 1 } }),
      feedRow("c", { title: "Gamma", fm: { status: "done" } }),
    ]);
    const engine = new QueryEngine(store, core);

    const open = await engine.run({ filter: openFilter, sort: [{ field: "fm.n", direction: "desc" }] });
    expect(open.rows.map((row) => row.id)).toEqual(["b", "a"]);
    expect(open.total).toBe(2);

    const all = await engine.run({});
    expect(all.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("pages with offset/limit and reports the pre-paging total", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a"), feedRow("b"), feedRow("c"), feedRow("d")]);
    const engine = new QueryEngine(store, core);
    const page = await engine.run({ offset: 1, limit: 2 });
    expect(page.rows.map((row) => row.id)).toEqual(["b", "c"]);
    expect(page.total).toBe(4);
  });

  it("hides tombstoned rows unless the query asks for them", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a"), feedRow("t", { deleted: true })]);
    const engine = new QueryEngine(store, core);
    expect((await engine.run({})).rows.map((row) => row.id)).toEqual(["a"]);
    expect((await engine.run({ includeDeleted: true })).rows.map((row) => row.id)).toEqual(["a", "t"]);
  });

  it("re-emits a live query when a matching row arrives", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a", { fm: { status: "open" } })]);
    const engine = new QueryEngine(store, core);
    const live = await engine.subscribe({ filter: openFilter });
    const seen: string[][] = [];
    live.onChange((result) => seen.push(result.rows.map((row) => row.id)));

    expect(live.result.rows.map((row) => row.id)).toEqual(["a"]);
    await apply(store, [feedRow("b", { fm: { status: "open" } })]);
    await flush();

    expect(seen).toEqual([["a", "b"]]);
    expect(live.result.total).toBe(2);
    live.close();
  });

  it("stays quiet when a change cannot touch the result", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a", { fm: { status: "open" } })]);
    const engine = new QueryEngine(store, core);
    const live = await engine.subscribe({ filter: openFilter });
    let emissions = 0;
    live.onChange(() => (emissions += 1));

    await apply(store, [feedRow("z", { fm: { status: "done" } })]);
    await flush();
    expect(emissions).toBe(0);

    // …but a row already in the result still counts as touched when it changes.
    await apply(store, [feedRow("a", { title: "renamed", fm: { status: "open" } })]);
    await flush();
    expect(emissions).toBe(1);
    expect(live.result.rows[0]?.title).toBe("renamed");
    live.close();
  });

  it("re-emits when a result row is tombstoned or purged", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a", { fm: { status: "open" } }), feedRow("b", { fm: { status: "open" } })]);
    const engine = new QueryEngine(store, core);
    const live = await engine.subscribe({ filter: openFilter });
    const seen: string[][] = [];
    live.onChange((result) => seen.push(result.rows.map((row) => row.id)));

    await apply(store, [feedRow("a", { fm: { status: "open" }, deleted: true })]);
    await flush();
    await apply(store, [feedRow("b", { deleted: true, purged: true })]);
    await flush();

    expect(seen).toEqual([["b"], []]);
    live.close();
  });

  it("stops listening once every subscription is closed", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a", { fm: { status: "open" } })]);
    const engine = new QueryEngine(store, core);
    const live = await engine.subscribe({ filter: openFilter });
    let emissions = 0;
    live.onChange(() => (emissions += 1));
    live.close();

    await apply(store, [feedRow("b", { fm: { status: "open" } })]);
    await flush();
    expect(emissions).toBe(0);
  });

  it("searches through the index, ranked, and intersects with a filter", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [
      feedRow("a", { title: "Groceries", content: "milk and bread", fm: { status: "open" } }),
      feedRow("b", { title: "Hardware", content: "milk crate", fm: { status: "done" } }),
      feedRow("c", { title: "Unrelated", content: "nothing here", fm: { status: "open" } }),
    ]);
    const engine = new QueryEngine(store, core, new MiniSearchIndex());
    await engine.warmUp();

    const hits = await engine.searchDocuments("milk");
    expect(hits.map((hit) => hit.id).sort()).toEqual(["a", "b"]);

    const openOnly = await engine.searchDocuments("milk", { filter: openFilter });
    expect(openOnly.map((hit) => hit.id)).toEqual(["a"]);

    const result = await engine.run({ search: "groceries" });
    expect(result.rows.map((row) => row.id)).toEqual(["a"]);
    await engine.close();
  });

  it("indexes new feed rows incrementally, without a rebuild", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a", { title: "first", content: "alpha" })]);
    const index = new MiniSearchIndex();
    const engine = new QueryEngine(store, core, index);
    await engine.warmUp();
    expect((await index.stats()).documents).toBe(1);

    await apply(store, [feedRow("b", { title: "second", content: "bravo" })]);
    await flush();

    expect((await index.stats()).documents).toBe(2);
    expect((await engine.searchDocuments("bravo")).map((hit) => hit.id)).toEqual(["b"]);

    // A purge drops the row from the index too.
    await apply(store, [feedRow("b", { deleted: true, purged: true })]);
    await flush();
    expect(await engine.searchDocuments("bravo")).toEqual([]);
    await engine.close();
  });

  it("reuses a persisted index instead of rebuilding it on the next boot", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a", { title: "Persisted", content: "durable text" })]);
    const persistence = new MemorySearchPersistence();

    const first = new QueryEngine(store, core, new MiniSearchIndex({ persistence }));
    await first.warmUp();
    await first.close(); // flushes the debounced persist

    const entry = await persistence.load();
    expect(entry?.version).toBe(SEARCH_INDEX_VERSION);
    expect(entry?.documents).toBe(1);
    expect(entry?.safeSeq).toBeGreaterThan(0);

    // Second boot: open() deserializes, and the catch-up pass finds nothing to do.
    const reopened = new MiniSearchIndex({ persistence });
    await reopened.open();
    const stats = await reopened.stats();
    expect(stats.documents).toBe(1);
    expect(stats.safeSeq).toBe(entry?.safeSeq);

    const second = new QueryEngine(store, core, reopened);
    expect((await second.searchDocuments("durable")).map((hit) => hit.id)).toEqual(["a"]);
    await second.close();
  });

  it("rebuilds exactly once when SEARCH_INDEX_VERSION moves", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a", { title: "Stale", content: "old index" })]);
    const persistence = new MemorySearchPersistence();
    await persistence.save({
      version: SEARCH_INDEX_VERSION + 1,
      safeSeq: 9_999,
      builtAt: 1,
      documents: 1,
      index: "{}",
    });

    const index = new MiniSearchIndex({ persistence });
    const engine = new QueryEngine(store, core, index);
    await engine.warmUp();

    // The stale entry is discarded (watermark back to 0) and the store re-indexed.
    expect((await index.stats()).documents).toBe(1);
    expect((await engine.searchDocuments("old")).map((hit) => hit.id)).toEqual(["a"]);
    await engine.close();
  });

  it("explains itself when search is used without an index", async () => {
    const engine = new QueryEngine(new MemoryProjectionStore(), core);
    await expect(engine.searchDocuments("anything")).rejects.toThrow(/no search index/);
  });
});
