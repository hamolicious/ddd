import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoreMap, DocumentRow, DocumentsApi } from "@kernel";

import { fakeSearch } from "../../_shared/fake-search.test-util.js";

import type { AutoField } from "./fields.js";
import { watch } from "./watcher.js";

const ME = "user-me";

function row(id: string, fm: CoreMap, over: Partial<DocumentRow> = {}): DocumentRow {
  const at = "2026-09-29T09:00:00.000Z";
  return {
    id,
    title: id,
    fm,
    plugins: {},
    fm_parse_error: false,
    materialized_version: "1",
    created_at: at,
    created_by: ME,
    updated_at: at,
    updated_by: ME,
    deleted: false,
    deleted_at: null,
    deleted_by: null,
    purged: false,
    ...over,
  };
}

function fake(initial: readonly DocumentRow[]) {
  const rows = new Map(initial.map((each) => [each.id, each]));
  const writes: [string, string, unknown][] = [];
  const search = fakeSearch((plan) => {
    const text = JSON.stringify(plan);
    if (text.includes('"select"')) return [{ id: "match" }];
    return [...rows.values()];
  });
  const documents = {
    get: vi.fn(async (id: string) => rows.get(id)),
    splice: {
      setFrontmatterValue: vi.fn(async (id: string, key: string, value: unknown) => {
        writes.push([id, key, value]);
        const before = rows.get(id);
        if (before) rows.set(id, { ...before, fm: { ...before.fm, [key]: value as never } });
      }),
    },
  };
  return {
    documents: documents as unknown as Pick<DocumentsApi, "get" | "splice">,
    search: search.search,
    writes,
    change(next: DocumentRow) {
      rows.set(next.id, next);
      search.emit();
    },
  };
}

const field = (key: string, value: string, on: AutoField["on"] = "create"): AutoField => ({
  id: key,
  key,
  value,
  on,
  when: { combine: "and", clauses: [] },
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the watcher", () => {
  const closers: (() => void)[] = [];
  afterEach(() => closers.splice(0).forEach((close) => close()));

  const start = (store: ReturnType<typeof fake>, fields: AutoField[], active = true) => {
    const watcher = watch({ documents: store.documents, search: store.search, userId: ME, fields: () => fields, active: () => active, warn: () => {} });
    closers.push(() => watcher.close());
    return watcher;
  };

  it("leaves the notes that were there when it started", async () => {
    const store = fake([row("old", {})]);
    start(store, [field("status", "open", "edit")]);
    await settle();
    expect(store.writes).toEqual([]);
  });

  it("adds what a new note lacks and nothing it has", async () => {
    const store = fake([]);
    start(store, [field("status", "open"), field("title", "x"), field("n", "3")]);
    await settle();
    store.change(row("new", { title: "Hello" }, { materialized_version: "local" }));
    await settle();
    await settle();
    expect(store.writes).toEqual([
      ["new", "status", "open"],
      ["new", "n", 3],
    ]);
  });

  it("adds edit properties to an edited note, not new-note ones", async () => {
    const store = fake([row("old", {})]);
    start(store, [field("status", "open"), field("seen", "true", "edit")]);
    await settle();
    store.change(row("old", {}, { updated_at: "2026-09-29T10:00:00.000Z" }));
    await settle();
    await settle();
    expect(store.writes).toEqual([["old", "seen", true]]);
  });

  it("ignores someone else's edit, and this user's on a device not in use", async () => {
    const store = fake([row("old", {})]);
    start(store, [field("seen", "true", "edit")], false);
    await settle();
    store.change(row("old", {}, { updated_at: "2026-09-29T10:00:00.000Z" }));
    store.change(row("old", {}, { updated_at: "2026-09-29T11:00:00.000Z", updated_by: "someone" }));
    await settle();
    expect(store.writes).toEqual([]);
  });

  it("does not write a key typed in the meantime", async () => {
    const store = fake([]);
    start(store, [field("status", "open")]);
    await settle();
    const made = row("new", {}, { materialized_version: "local" });
    store.change(made);
    store.change({ ...made, fm: { status: "mine" } });
    await settle();
    await settle();
    expect(store.writes).toEqual([]);
  });
});
