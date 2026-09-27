/**
 * The outbox (`dev-docs/resolved/SYNC-DECISIONS.md` §1–§2): creates, trashes and restores made while
 * the server cannot be reached wait in order, show at once, and go out on reconnect —
 * and a create sent twice, or an id someone else took, loses nothing.
 */

import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { MemoryProjectionStore, feedRow } from "../store/testing.js";
import type { DocHydrator } from "../sync/doc-hydration.js";
import { NoticeCenter } from "./notices.js";
import { LocalRows, Outbox, isTransient, type OutboxOp } from "./outbox.js";
import { mintUlid } from "./ulid.js";

const ID = "01J8ZQ0M3M4YQV0X0PTN9R2G7C";

const offline = (): Error => Object.assign(new Error("offline"), { status: 0, code: "offline" });
const refused = (status: number, message = "no"): Error => Object.assign(new Error(message), { status });

function seedState(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

function setup(api: (path: string, init?: RequestInit) => Promise<Response>) {
  const store = new MemoryProjectionStore();
  const notices = new NoticeCenter();
  const hydrator = {
    created: vi.fn(),
    forget: vi.fn(() => Promise.resolve()),
    localText: vi.fn(() => Promise.resolve("my offline text")),
  };
  let online = true;
  const createNote = vi.fn(() => Promise.resolve("01J8ZQ0M3M4YQV0X0PTN9R2G7Z"));
  const outbox = new Outbox({
    store,
    hydrator: hydrator as unknown as DocHydrator,
    api: vi.fn(api),
    notices,
    online: () => online,
    createNote,
  });
  return {
    store,
    notices,
    hydrator,
    outbox,
    createNote,
    setOnline: (value: boolean) => {
      online = value;
    },
  };
}

describe("Outbox", () => {
  it("keeps ops while offline and sends them in order once online", async () => {
    const calls: string[] = [];
    const t = setup(async (path, init) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      return new Response("{}", { status: 200 });
    });
    t.setOnline(false);
    const state = seedState("# New\n");
    await t.outbox.add({ kind: "create", id: ID, at: 1, state });
    await t.outbox.add({ kind: "delete", id: ID, at: 2 });
    await t.outbox.add({ kind: "restore", id: ID, at: 3 });
    expect(calls).toEqual([]);
    expect(await t.outbox.ops()).toHaveLength(3);

    t.setOnline(true);
    await t.outbox.drain();
    expect(calls).toEqual([`POST /documents`, `DELETE /documents/${ID}`, `POST /documents/${ID}/restore`]);
    expect(t.hydrator.created).toHaveBeenCalledWith(ID);
    expect(await t.outbox.isEmpty()).toBe(true);
  });

  it("creates from the device's state, base64", async () => {
    let body: { id?: string; state?: string } = {};
    const t = setup(async (_path, init) => {
      body = JSON.parse(String(init?.body)) as typeof body;
      return new Response("{}", { status: 201 });
    });
    const state = seedState("hello");
    await t.outbox.add({ kind: "create", id: ID, at: 1, state });
    await t.outbox.drain();
    expect(body.id).toBe(ID);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Uint8Array.from(atob(body.state!), (char) => char.charCodeAt(0)));
    expect(doc.getText("content").toString()).toBe("hello");
  });

  it("stops at the first op the server did not answer, and keeps it", async () => {
    const t = setup(async () => {
      throw offline();
    });
    await t.outbox.add({ kind: "delete", id: ID, at: 1 });
    await t.outbox.drain();
    expect(await t.outbox.ops()).toHaveLength(1);
  });

  it("treats a 409 on a create whose state the server already holds as done (a lost reply)", async () => {
    const state = seedState("once");
    const t = setup(async (path, init) => {
      if (init?.method === "POST") throw refused(409);
      expect(path).toContain("format=crdt");
      return new Response(state.slice().buffer, { status: 200 });
    });
    await t.outbox.add({ kind: "create", id: ID, at: 1, state });
    await t.outbox.drain();
    expect(t.hydrator.created).toHaveBeenCalledWith(ID);
    expect(t.createNote).not.toHaveBeenCalled();
    expect(await t.outbox.isEmpty()).toBe(true);
  });

  it("saves the text as a new note when the id belongs to another note", async () => {
    const theirs = seedState("someone else's");
    const t = setup(async (_path, init) => {
      if (init?.method === "POST") throw refused(409);
      return new Response(theirs.slice().buffer, { status: 200 });
    });
    await t.store.putLocal([{ ...feedRow({ id: ID, seq: 0 }), title: "Mine" }]);
    await t.outbox.add({ kind: "create", id: ID, at: 1, state: seedState("mine") });
    await t.outbox.drain();
    expect(t.hydrator.forget).toHaveBeenCalledWith(ID);
    expect(t.createNote).toHaveBeenCalledWith("my offline text");
    expect(await t.store.get(ID)).toBeUndefined();
    expect(t.notices.list().map((notice) => notice.message)).toEqual([
      "A note made offline could not keep its id, so it was saved as a new note.",
    ]);
  });

  it("undoes a refused trash locally and says why", async () => {
    const t = setup(async () => {
      throw refused(403, "Only the owner can do that.");
    });
    const before = { ...feedRow({ id: ID, seq: 4 }), title: "Plans" };
    await t.store.applyRows([{ ...before }], { safeSeq: 4, updatedAt: 0, coreSemanticsVersion: null, bootstrapped: true });
    const local = new LocalRows(t.store, () => {
      throw new Error("no core");
    }, "me");
    const was = await local.trashed(ID, true);
    expect((await t.store.get(ID))?.deleted).toBe(true);

    await t.outbox.add({ kind: "delete", id: ID, at: 1, ...(was ? { before: was } : {}) });
    await t.outbox.drain();
    expect((await t.store.get(ID))?.deleted).toBe(false);
    expect(t.notices.list()[0]?.message).toBe("“Plans” could not be moved to Trash: Only the owner can do that.");
    expect(await t.outbox.isEmpty()).toBe(true);
  });

  it("skips a create the server refuses as it is, and goes on with the rest", async () => {
    const calls: string[] = [];
    const t = setup(async (path, init) => {
      calls.push(`${init?.method} ${path}`);
      if (path === "/documents") throw refused(413, "too large");
      return new Response("{}", { status: 200 });
    });
    const ops: OutboxOp[] = [
      { kind: "create", id: ID, at: 1, state: seedState("big") },
      { kind: "delete", id: "01J8ZQ0M3M4YQV0X0PTN9R2G7D", at: 2 },
    ];
    for (const op of ops) await t.outbox.add(op);
    await t.outbox.drain();
    expect(calls).toContain("DELETE /documents/01J8ZQ0M3M4YQV0X0PTN9R2G7D");
    expect((await t.outbox.ops()).map((op) => op.kind)).toEqual(["create"]);
  });
});

describe("LocalRows", () => {
  it("shows a note made offline, and keeps it through a bootstrap pass", async () => {
    const store = new MemoryProjectionStore();
    const local = new LocalRows(store, () => ({ title: "Train", fm: { path: "work" }, plugins: {}, fm_parse_error: false }), "me");
    await local.created(ID, "---\npath: work\n---\n# Train\n");
    expect(await store.get(ID)).toMatchObject({ title: "Train", fm: { path: "work" }, local: true, seq: 0, created_by: "me" });
    expect(await store.retainOnly(new Set())).toEqual([]);
    // The server's row replaces it.
    await store.applyRows([{ ...feedRow({ id: ID, seq: 9 }), title: "Train" }], {
      safeSeq: 9,
      updatedAt: 0,
      coreSemanticsVersion: null,
      bootstrapped: true,
    });
    expect((await store.get(ID))?.local).toBeUndefined();
  });

  it("lays an offline edit over the current row, keeping its seq", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryProjectionStore();
      await store.applyRows([{ ...feedRow({ id: ID, seq: 3 }), title: "Old", content: "# Old\n" }], {
        safeSeq: 3,
        updatedAt: 0,
        coreSemanticsVersion: null,
        bootstrapped: true,
      });
      const local = new LocalRows(store, () => ({ title: "Moved", fm: { path: "archive" }, plugins: {}, fm_parse_error: false }), "me");
      local.edited(ID, "---\npath: archive\n---\n# Moved\n");
      await vi.runAllTimersAsync();
      expect(await store.get(ID)).toMatchObject({ seq: 3, local: true, title: "Moved", fm: { path: "archive" } });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("helpers", () => {
  it("mints ULIDs the server accepts: 26 Crockford characters, time first", () => {
    const id = mintUlid(Date.UTC(2026, 8, 27));
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(mintUlid(Date.UTC(2026, 8, 28)) > id).toBe(true);
  });

  it("knows which errors are worth retrying", () => {
    expect(isTransient(offline())).toBe(true);
    expect(isTransient(refused(503))).toBe(true);
    expect(isTransient(refused(401))).toBe(true);
    expect(isTransient(refused(409))).toBe(false);
    expect(isTransient(refused(400))).toBe(false);
  });
});
