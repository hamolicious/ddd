import { beforeAll, describe, expect, it } from "vitest";

import type { CoreMap, FeedRow } from "../protocol.js";
import { MemoryProjectionStore } from "../store/testing.js";
import type { CoreBindings, FilterJson } from "../wasm/index.js";
import { coreArtifactExists, loadCoreForNode } from "../wasm/node-core.js";
import { QueryEngine } from "./index.js";
import { MemorySearchPersistence, SEARCH_INDEX_VERSION, WasmEngineIndex } from "./search.js";

let seq = 0;

function feedRow(
  id: string,
  fields: {
    title?: string;
    content?: string;
    fm?: CoreMap;
    plugins?: CoreMap;
    deleted?: boolean;
    purged?: boolean;
  } = {},
): FeedRow {
  seq += 1;
  const stamp = `2026-01-${String((seq % 28) + 1).padStart(2, "0")}T00:00:00.000Z`;
  return {
    seq,
    id,
    title: fields.title ?? id,
    content: fields.content ?? "",
    fm: fields.fm ?? {},
    plugins: fields.plugins ?? {},
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

  const folder = (id: string, children: readonly string[]) =>
    feedRow(id, { plugins: { folders: { children: [...children] } } });

  it("answers folder relations, and re-runs them when a folder changes", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [folder("root", ["a", "sub"]), folder("sub", ["b"]), feedRow("a"), feedRow("b"), feedRow("c")]);
    const engine = new QueryEngine(store, core);

    const deep = { child_of: { of: "root", deep: true } } as FilterJson;
    const ids = async (filter: FilterJson) =>
      (await engine.run({ filter, sort: [{ field: "id", direction: "asc" }] })).rows.map((row) => row.id);
    expect(await ids(deep)).toEqual(["a", "b", "sub"]);
    expect(await ids({ child_of: { of: "root" } } as FilterJson)).toEqual(["a", "sub"]);
    expect(await ids({ parent_of: { of: "b" } } as FilterJson)).toEqual(["sub"]);

    const live = await engine.subscribe({ filter: deep, sort: [{ field: "id", direction: "asc" }] });
    const seen: string[][] = [];
    live.onChange((result) => seen.push(result.rows.map((row) => row.id)));
    await apply(store, [folder("sub", ["b", "c"])]);
    await flush();
    expect(seen).toEqual([["a", "b", "c", "sub"]]);
    live.close();
    await engine.close();
  });

  it("answers plans with a cursor, the total and the text hits", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [
      feedRow("a", { title: "Groceries", content: "# List\nbuy milk", fm: { n: 2 } }),
      feedRow("b", { title: "Milk run", content: "", fm: { n: 1 } }),
      feedRow("c", { title: "Other", content: "nothing" }),
    ]);
    const engine = new QueryEngine(store, core);

    const first = await engine.runPlan({ text: "milk", sort: ["fm.n"], limit: 1, snippets: true });
    expect(first.rows.map((row) => row.id)).toEqual(["b"]);
    expect(first.total).toBe(2);
    expect(first.hits["b"]?.terms).toEqual(["milk"]);
    expect(first.nextCursor).toBeDefined();

    const rest = await engine.runPlan({ text: "milk", sort: ["fm.n"], limit: 1, snippets: true, cursor: first.nextCursor });
    expect(rest.rows.map((row) => row.id)).toEqual(["a"]);
    expect(rest.hits["a"]?.snippet).toEqual({ text: "buy milk", ranges: [{ start: 4, end: 8 }], line: 2 });
    expect(rest.nextCursor).toBeUndefined();

    await expect(engine.runPlan({ sort: ["nope"] })).rejects.toThrow();

    const live = await engine.subscribePlan({ text: "milk", sort: ["fm.n"] });
    const seen: string[][] = [];
    live.onChange((result) => seen.push(result.rows.map((row) => row.id)));
    await apply(store, [feedRow("c", { title: "Other", content: "oat milk", fm: { n: 0 } })]);
    await flush();
    expect(seen).toEqual([["c", "b", "a"]]);
    live.close();
    await engine.close();
  });

  it("keeps one-shot queries current with no live query open", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a")]);
    const engine = new QueryEngine(store, core);
    expect((await engine.run({})).total).toBe(1);
    await apply(store, [feedRow("b")]);
    await flush();
    expect((await engine.run({})).total).toBe(2);
    await engine.close();
  });

  it("searches through the index, ranked, and intersects with a filter", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [
      feedRow("a", { title: "Groceries", content: "milk and bread", fm: { status: "open" } }),
      feedRow("b", { title: "Hardware", content: "milk crate", fm: { status: "done" } }),
      feedRow("c", { title: "Unrelated", content: "nothing here", fm: { status: "open" } }),
    ]);
    const engine = new QueryEngine(store, core, new WasmEngineIndex({ core }));
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
    const index = new WasmEngineIndex({ core });
    const engine = new QueryEngine(store, core, index);
    await engine.warmUp();
    expect((await index.stats()).documents).toBe(1);

    await apply(store, [feedRow("b", { title: "second", content: "bravo" })]);
    await flush();

    expect((await index.stats()).documents).toBe(2);
    expect((await engine.searchDocuments("bravo")).map((hit) => hit.id)).toEqual(["b"]);

    await apply(store, [feedRow("b", { deleted: true, purged: true })]);
    await flush();
    expect(await engine.searchDocuments("bravo")).toEqual([]);
    await engine.close();
  });

  it("reuses a persisted index instead of rebuilding it on the next boot", async () => {
    const store = new MemoryProjectionStore();
    await apply(store, [feedRow("a", { title: "Persisted", content: "durable text" })]);
    const persistence = new MemorySearchPersistence();

    const first = new QueryEngine(store, core, new WasmEngineIndex({ core, persistence }));
    await first.warmUp();
    await first.close();

    const entry = await persistence.load();
    expect(entry?.version).toBe(SEARCH_INDEX_VERSION);
    expect(entry?.documents).toBe(1);
    expect(entry?.safeSeq).toBeGreaterThan(0);

    const reopened = new WasmEngineIndex({ core, persistence });
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

    const index = new WasmEngineIndex({ core, persistence });
    const engine = new QueryEngine(store, core, index);
    await engine.warmUp();

    expect((await index.stats()).documents).toBe(1);
    expect((await engine.searchDocuments("old")).map((hit) => hit.id)).toEqual(["a"]);
    await engine.close();
  });

});
