import { beforeAll, describe, expect, it } from "vitest";

import type { FeedRow } from "../protocol.js";
import { MemoryProjectionStore, feedRow } from "../store/testing.js";
import type { CoreBindings } from "../wasm/index.js";
import { coreArtifactExists, loadCoreForNode } from "../wasm/node-core.js";
import { ProjectionHost } from "./backend.js";
import { ProjectionFeed } from "./feed.js";

const checkpoint = (rows: readonly FeedRow[]) => ({
  safeSeq: Math.max(0, ...rows.map((row) => row.seq)),
  updatedAt: 0,
  coreSemanticsVersion: 1,
  bootstrapped: true,
});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe.skipIf(!coreArtifactExists())("search projection", () => {
  let core: CoreBindings;

  beforeAll(async () => {
    core = await loadCoreForNode();
  });

  async function setup(rows: readonly FeedRow[] = []) {
    const store = new MemoryProjectionStore();
    if (rows.length > 0) await store.applyRows(rows, checkpoint(rows));
    const backend = new ProjectionHost({ core, persistent: false });
    const feed = new ProjectionFeed(store, backend);
    return { store, backend, feed };
  }

  it("builds every source from the local store before it is ready", async () => {
    const { feed } = await setup([
      feedRow({ id: "A", seq: 1, content: "---\nstatus: open\n---\n# A\n\n- [ ] one\n[b](doc://B)\n" }),
      feedRow({ id: "B", seq: 2, content: "# B\n", deleted: true, deleted_at: "2026-09-25T00:00:00.000Z" }),
    ]);
    const progress: number[] = [];
    feed.onProgress(({ done }) => progress.push(done));
    const status = await feed.start();
    expect(status.documents).toBe(2);
    expect(status.persistent).toBe(false);
    expect(progress.at(-1)).toBe(2);
    expect(await feed.select("SELECT key, value FROM fm WHERE doc = 'A'")).toEqual([{ key: "status", value: "open" }]);
    expect(await feed.select("SELECT text FROM tasks")).toEqual([{ text: "one" }]);
    expect(await feed.select("SELECT target, state FROM links")).toEqual([{ target: "B", state: "trashed" }]);
  });

  it("follows local edits, unsent creates and pending deletes", async () => {
    const { store, feed } = await setup([feedRow({ id: "A", seq: 1, content: "# A\n" })]);
    await feed.start();
    const row = (await store.get("A"))!;
    await store.putLocal([{ ...row, content: "# A\n\n- [ ] typed offline\n", updated_at: "2026-09-26T00:00:00.000Z" }]);
    await store.putLocal([
      { ...feedRow({ id: "N", seq: 0, content: "# New\n" }), materialized_version: "local", seq: 0 },
    ]);
    await store.putLocal([{ ...(await store.get("A"))!, deleted: true, deleted_at: "2026-09-27T00:00:00.000Z" }]);
    await flush();
    await feed.settled();
    expect(await feed.select("SELECT id, deleted, materialized_version FROM documents ORDER BY id")).toEqual([
      { id: "A", deleted: 1, materialized_version: "v1" },
      { id: "N", deleted: 0, materialized_version: "local" },
    ]);
    expect(await feed.select("SELECT text FROM tasks")).toEqual([{ text: "typed offline" }]);
  });

  it("takes the title and frontmatter from the local text", async () => {
    const { feed } = await setup([
      feedRow({ id: "A", seq: 1, title: "Server title", fm: { status: "old" }, content: "---\nstatus: new\n---\n# Local title\n" }),
    ]);
    await feed.start();
    expect(await feed.select("SELECT title, fm FROM documents")).toEqual([
      { title: "Local title", fm: '{"status":"new"}' },
    ]);
  });

  it("removes purged documents from every source", async () => {
    const { store, feed } = await setup([feedRow({ id: "A", seq: 1, content: "- [ ] t\n[b](doc://B)\n" })]);
    await feed.start();
    await store.applyRows([feedRow({ id: "A", seq: 2, purged: true })], checkpoint([feedRow({ id: "A", seq: 2 })]));
    await flush();
    await feed.settled();
    for (const table of ["documents", "fm", "link_refs", "tasks", "attachments"]) {
      expect(await feed.select(`SELECT count(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
    }
  });

  it("holds changes that arrive during the first build and applies them after", async () => {
    const { store, feed } = await setup([feedRow({ id: "A", seq: 1 })]);
    const started = feed.start();
    await store.applyRows([feedRow({ id: "B", seq: 2 })], checkpoint([feedRow({ id: "B", seq: 2 })]));
    await started;
    await flush();
    await feed.settled();
    expect(await feed.select("SELECT id FROM documents ORDER BY id")).toEqual([{ id: "A" }, { id: "B" }]);
  });

  it("skips unchanged rows and drops rows the store no longer has when it syncs again", async () => {
    const { store, backend } = await setup([feedRow({ id: "A", seq: 1 }), feedRow({ id: "B", seq: 2 })]);
    await new ProjectionFeed(store, backend).start();
    store.rows.delete("B");
    const rows = [...store.rows.values()];
    expect(await backend.sync(rows, true, true)).toBe(1);
    expect(await backend.select("SELECT id FROM documents")).toEqual([{ id: "A" }]);
    expect(await backend.sync(rows, true, true)).toBe(0);
  });
});
