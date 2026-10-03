import {
  CapabilityUnavailableError,
  SearchPlanError,
  type PluginManifest,
  type SearchApi,
} from "@kernel";
import { beforeAll, describe, expect, it } from "vitest";

import type { FeedRow } from "../protocol.js";
import { MemoryProjectionStore, feedRow } from "../store/testing.js";
import type { CoreBindings } from "../wasm/index.js";
import { coreArtifactExists, loadCoreForNode } from "../wasm/node-core.js";
import { ProjectionHost } from "./backend.js";
import { ProjectionFeed } from "./feed.js";
import { SearchHost } from "./host.js";

const checkpoint = (rows: readonly FeedRow[]) => ({
  safeSeq: Math.max(0, ...rows.map((row) => row.seq)),
  updatedAt: 0,
  coreSemanticsVersion: 1,
  bootstrapped: true,
});

const frame = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

const manifest = (documents: readonly ("read" | "write")[] = ["read"]) =>
  ({ id: "probe", version: "1.0.0", capabilities: { documents } }) as unknown as PluginManifest;

describe.skipIf(!coreArtifactExists())("kernel.search", () => {
  let core: CoreBindings;

  beforeAll(async () => {
    core = await loadCoreForNode();
  });

  async function setup(rows: readonly FeedRow[]) {
    const store = new MemoryProjectionStore();
    await store.applyRows(rows, checkpoint(rows));
    const backend = new ProjectionHost({ core, persistent: false });
    const feed = new ProjectionFeed(store, backend);
    void feed.start();
    const host = new SearchHost(feed);
    const runs: string[] = [];
    const original = backend.run.bind(backend);
    backend.run = (plan) => {
      runs.push(JSON.stringify(plan));
      return original(plan);
    };
    const search: SearchApi = host.forPlugin(manifest(), (dispose) => dispose);
    return { store, feed, host, search, runs };
  }

  it("runs a pipeline with inferred rows", async () => {
    const { search } = await setup([
      feedRow({ id: "A", seq: 1, content: "---\nstatus: open\n---\n# Alpha\n" }),
      feedRow({ id: "B", seq: 2, content: "---\nstatus: done\n---\n# Beta\n" }),
    ]);
    const result = await search.from().where("fm.status", "eq", "open").select("id", "title").withTotal().run();
    expect(result).toEqual({ rows: [{ id: "A", title: "Alpha" }], total: 1 });
  });

  it("rejects bad plans with a typed error", async () => {
    const { search } = await setup([]);
    const error = await search.from().sort("relevance").run().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(SearchPlanError);
    expect((error as SearchPlanError).kind).toBe("bad_stage");
  });

  it("refuses plugins without documents: read", async () => {
    const { host } = await setup([]);
    const search = host.forPlugin(manifest(["write"]), (dispose) => dispose);
    await expect(search.from().run()).rejects.toBeInstanceOf(CapabilityUnavailableError);
    await expect(search.from().watch()).rejects.toBeInstanceOf(CapabilityUnavailableError);
  });

  it("watches re-run when a source they read changes, once per frame", async () => {
    const { store, search, runs } = await setup([feedRow({ id: "A", seq: 1, content: "# A\n\n- [ ] one\n" })]);
    const tasks = await search.from("tasks").where("state", "eq", "open").select("text").watch();
    expect(tasks.result.rows).toEqual([{ text: "one" }]);
    expect(tasks.result.total).toBe(1);
    const seen: unknown[] = [];
    tasks.onChange((result) => seen.push(result.rows));
    const before = runs.length;
    const row = (await store.get("A"))!;
    for (const text of ["two", "three", "four"]) {
      await store.putLocal([{ ...row, content: `# A\n\n- [ ] ${text}\n`, updated_at: `2026-10-0${text.length}T00:00:00Z` }]);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await frame();
    expect(seen.at(-1)).toEqual([{ text: "four" }]);
    expect(runs.length - before).toBeLessThanOrEqual(2);
    tasks.close();
  });

  it("stays quiet when a change cannot touch what the watch reads", async () => {
    const { store, search } = await setup([feedRow({ id: "A", seq: 1, content: "# A\n\n- [ ] one\n" })]);
    const tasks = await search.from("tasks").watch();
    let changes = 0;
    tasks.onChange(() => changes++);
    const row = (await store.get("A"))!;
    await store.putLocal([{ ...row, content: "# A renamed\n\n- [ ] one\n", updated_at: "2026-10-05T00:00:00Z" }]);
    await frame();
    await frame();
    expect(changes).toBe(1);
    const docs = await search.from().select("id").watch();
    let docChanges = 0;
    docs.onChange(() => docChanges++);
    await store.putLocal([{ ...(await store.get("A"))!, content: "# A again\n\n- [ ] one\n", updated_at: "2026-10-06T00:00:00Z" }]);
    await frame();
    await frame();
    expect(docChanges).toBe(0);
  });

  it("moves a live window with an exact total", async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      feedRow({ id: `D${String(index).padStart(2, "0")}`, seq: index + 1, content: `# Doc ${index}\n` }),
    );
    const { store, search } = await setup(rows);
    const watch = await search.from().sort("id").select("id").watch();
    expect(watch.result.total).toBe(30);
    await watch.window(10, 5);
    expect(watch.result.start).toBe(10);
    expect(watch.result.rows.map((row) => row.id)).toEqual(["D10", "D11", "D12", "D13", "D14"]);
    await store.putLocal([{ ...feedRow({ id: "D00a", seq: 0, content: "# New\n" }), materialized_version: "local" }]);
    await frame();
    await frame();
    expect(watch.result.total).toBe(31);
    expect(watch.result.rows.map((row) => row.id)).toEqual(["D09", "D10", "D11", "D12", "D13"]);
  });

  it("a re-run that started before a window moved never overwrites the window", async () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      feedRow({ id: `D${String(index).padStart(2, "0")}`, seq: index + 1, content: `# Doc ${index}\n` }),
    );
    const { store, search } = await setup(rows);
    const watch = await search.from().sort("id").select("id").watch();
    await store.putLocal([{ ...feedRow({ id: "D99", seq: 0, content: "# Late\n" }), materialized_version: "local" }]);
    await watch.window(0, 5);
    await frame();
    await frame();
    expect(watch.result.rows.map((row) => row.id)).toEqual(["D00", "D01", "D02", "D03", "D04"]);
    expect(watch.result.total).toBe(31);
  });

  it("closing a watch stops its updates", async () => {
    const { store, search, host } = await setup([feedRow({ id: "A", seq: 1 })]);
    const watch = await search.from().watch();
    expect(host.watching).toBe(1);
    watch.close();
    expect(host.watching).toBe(0);
    await store.putLocal([{ ...(await store.get("A"))!, title: "x", content: "# x\n" }]);
    await frame();
    expect(watch.result.rows).toHaveLength(1);
  });
});
