import { describe, expect, it, vi } from "vitest";

import { BootstrapClient, BootstrapHttpError, ndjson } from "./bootstrap.js";
import { MemoryProjectionStore, feedRow } from "../store/testing.js";
import type { BootstrapFooter, BootstrapHeader, FeedRow } from "../protocol.js";

const ORIGIN = "http://127.0.0.1:8080";

function header(overrides: Partial<BootstrapHeader> = {}): BootstrapHeader {
  return {
    type: "header",
    protocol: 1,
    safe_seq: 100,
    total: 3,
    limit: 200,
    cursor: null,
    core_semantics_version: 1,
    ...overrides,
  };
}

function footer(overrides: Partial<BootstrapFooter> = {}): BootstrapFooter {
  return { type: "footer", count: 0, next_cursor: null, complete: true, safe_seq: 100, ...overrides };
}

function page(lines: Array<BootstrapHeader | BootstrapFooter | (FeedRow & { type: "row" })>): string {
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function row(id: string, seq: number): FeedRow & { type: "row" } {
  return { type: "row", ...feedRow({ id, seq }) };
}

function scriptedFetch(bodies: string[], status = 200) {
  const calls: string[] = [];
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)] ?? "";
    return new Response(body, { status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("requestUrl", () => {
  it("carries limit, trash, cursor and probe", () => {
    const client = new BootstrapClient(new MemoryProjectionStore(), {
      url: `${ORIGIN}/api/sync/bootstrap`,
      limit: 500,
      trash: "all",
      includeContent: false,
    });
    const first = new URL(client.requestUrl(null));
    expect(first.searchParams.get("limit")).toBe("500");
    expect(first.searchParams.get("trash")).toBe("all");
    expect(first.searchParams.get("include_content")).toBe("false");
    expect(first.searchParams.get("cursor")).toBeNull();

    const next = new URL(client.requestUrl("01J8ZR"));
    expect(next.searchParams.get("cursor")).toBe("01J8ZR");
    expect(new URL(client.requestUrl(null, true)).searchParams.get("probe")).toBe("1");
  });
});

describe("page", () => {
  it("parses header, rows and footer", async () => {
    const store = new MemoryProjectionStore();
    const { impl } = scriptedFetch([
      page([header(), row("a", 1), row("b", 2), footer({ count: 2, next_cursor: "b", complete: false })]),
    ]);
    const client = new BootstrapClient(store, {
      url: `${ORIGIN}/api/sync/bootstrap`,
      fetchImpl: impl,
    });

    const result = await client.page(null);
    expect(result.header.safe_seq).toBe(100);
    expect(result.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.rows[0]).not.toHaveProperty("type");
    expect(result.nextCursor).toBe("b");
    expect(result.complete).toBe(false);
  });

  it("refuses a page from a different protocol version", async () => {
    const { impl } = scriptedFetch([page([header({ protocol: 2 }), footer()])]);
    const client = new BootstrapClient(new MemoryProjectionStore(), {
      url: `${ORIGIN}/api/sync/bootstrap`,
      fetchImpl: impl,
    });
    await expect(client.page(null)).rejects.toThrow(/protocol 2/);
  });
});

describe("run", () => {
  it("streams every page, pins safe_seq from the first one, and GCs at the end", async () => {
    const store = new MemoryProjectionStore();
    await store.applyRows([feedRow({ id: "stale", seq: 1 })], {
      safeSeq: 1,
      updatedAt: 0,
      coreSemanticsVersion: 1,
      bootstrapped: false,
    });

    const { impl, calls } = scriptedFetch([
      page([header({ total: 3 }), row("a", 10), footer({ count: 1, next_cursor: "a", complete: false })]),
      page([
        header({ total: 3, safe_seq: 999, cursor: "a" }),
        row("b", 11),
        row("c", 12),
        footer({ count: 2, next_cursor: null, complete: true, safe_seq: 999 }),
      ]),
    ]);
    const client = new BootstrapClient(store, {
      url: `${ORIGIN}/api/sync/bootstrap`,
      fetchImpl: impl,
    });

    const progress: number[] = [];
    const result = await client.run((update) => progress.push(update.rows));

    expect(calls).toHaveLength(2);
    expect(new URL(calls[1] as string).searchParams.get("cursor")).toBe("a");
    expect(result).toMatchObject({ safeSeq: 100, rows: 3, removed: ["stale"] });
    expect([...store.rows.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(progress.at(-1)).toBe(3);

    const checkpoint = await store.checkpoint();
    expect(checkpoint).toMatchObject({ safeSeq: 100, bootstrapped: true, coreSemanticsVersion: 1 });
  });

  it("does not advance the watermark while the pass is still running", async () => {
    const store = new MemoryProjectionStore();
    const { impl } = scriptedFetch([
      page([header(), row("a", 10), footer({ count: 1, next_cursor: "a", complete: false })]),
      page([header({ cursor: "a" }), row("b", 11), footer({ count: 1, complete: true })]),
    ]);
    const client = new BootstrapClient(store, {
      url: `${ORIGIN}/api/sync/bootstrap`,
      fetchImpl: impl,
    });

    await client.run();
    for (const batch of store.batches) expect(batch.checkpoint.safeSeq).toBe(0);
    expect((await store.checkpoint()).safeSeq).toBe(100);
  });

  it("skips garbage collection for a partial view of the workspace", async () => {
    const store = new MemoryProjectionStore();
    await store.applyRows([feedRow({ id: "trashed", seq: 1 })], {
      safeSeq: 1,
      updatedAt: 0,
      coreSemanticsVersion: 1,
      bootstrapped: true,
    });
    const { impl } = scriptedFetch([page([header(), row("a", 10), footer({ count: 1 })])]);
    const client = new BootstrapClient(store, {
      url: `${ORIGIN}/api/sync/bootstrap`,
      trash: "live",
      fetchImpl: impl,
    });

    const result = await client.run();
    expect(result.removed).toEqual([]);
    expect(store.rows.has("trashed")).toBe(true);
  });

  it("reports a 401 as re-authentication, without touching local data", async () => {
    const store = new MemoryProjectionStore();
    await store.applyRows([feedRow({ id: "a", seq: 1 })], {
      safeSeq: 1,
      updatedAt: 0,
      coreSemanticsVersion: 1,
      bootstrapped: true,
    });
    const { impl } = scriptedFetch(["unauthorized"], 401);
    const client = new BootstrapClient(store, {
      url: `${ORIGIN}/api/sync/bootstrap`,
      fetchImpl: impl,
    });

    await expect(client.run()).rejects.toBeInstanceOf(BootstrapHttpError);
    await expect(client.run()).rejects.toMatchObject({ status: 401 });
    expect(store.cleared).toBe(0);
    expect(store.rows.has("a")).toBe(true);
  });

  it("probes for the header alone", async () => {
    const { impl, calls } = scriptedFetch([page([header({ total: 5000 })])]);
    const client = new BootstrapClient(new MemoryProjectionStore(), {
      url: `${ORIGIN}/api/sync/bootstrap`,
      fetchImpl: impl,
    });
    const probed = await client.probe();
    expect(probed.total).toBe(5000);
    expect(new URL(calls[0] as string).searchParams.get("probe")).toBe("1");
  });
});

describe("ndjson", () => {
  it("splits lines, including a tail with no trailing newline", async () => {
    const body = new Response('{"a":1}\n{"b":2}\n{"c":3}').body;
    const lines: unknown[] = [];
    for await (const line of ndjson(body as ReadableStream<Uint8Array>)) lines.push(line);
    expect(lines).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});
