import { describe, expect, it } from "vitest";

import { Throughput, formatBytes, formatTimeLeft, sendInChunks, type Fetch } from "./uploader.js";

/**
 * `/api/uploads` in memory, with the server's rules: 409 for a chunk that is not where
 * the upload is, 404 for an upload it does not have. `trouble` breaks a request on
 * purpose, before the server sees it or after it acted but before the answer arrives.
 */
function fakeServer(chunkSize = 4) {
  const sessions = new Map<string, { size: number; bytes: number[]; done?: string }>();
  let next = 0;
  const calls: string[] = [];
  let trouble: ((method: string, path: string) => "before" | "after" | undefined) | undefined;

  const answer = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fail = (status: number): never => {
    throw Object.assign(new Error(`status ${String(status)}`), { status });
  };
  const view = (id: string) => {
    const session = sessions.get(id);
    if (!session) return fail(404);
    return { id, size: session.size, offset: session.bytes.length, chunk_size: chunkSize };
  };

  const fetch: Fetch = async (path, init = {}) => {
    const method = init.method ?? "GET";
    calls.push(`${method} ${path}`);
    init.signal?.throwIfAborted();
    const when = trouble?.(method, path);
    if (when === "before") fail(0);

    let response: Response;
    const [route, query] = path.split("?");
    const parts = (route ?? "").split("/").filter(Boolean);
    const id = parts[1] ?? "";
    if (method === "POST" && parts.length === 1) {
      const { size } = JSON.parse(String(init.body)) as { size: number };
      const created = `u${String((next += 1))}`;
      sessions.set(created, { size, bytes: [] });
      response = answer(201, view(created));
    } else if (method === "GET") {
      response = answer(200, view(id));
    } else if (method === "PATCH") {
      const session = sessions.get(id) ?? fail(404);
      const offset = Number(new URLSearchParams(query).get("offset"));
      if (offset !== session.bytes.length) fail(409);
      const chunk = new Uint8Array(await (init.body as Blob).arrayBuffer());
      session.bytes.push(...chunk);
      response = answer(200, view(id));
    } else if (method === "POST" && parts[2] === "complete") {
      const session = sessions.get(id) ?? fail(404);
      if (session.bytes.length !== session.size) fail(409);
      session.done ??= `A${id}`;
      response = answer(201, { attachment: { id: session.done, name: "f.bin" } });
    } else {
      response = fail(400);
    }
    if (when === "after") fail(0);
    return response;
  };

  return {
    fetch,
    calls,
    sessions,
    bytesOf: (id: string) => sessions.get(id)?.bytes ?? [],
    breakWhen(rule: typeof trouble) {
      trouble = rule;
    },
  };
}

const file = (length: number): Blob => new Blob([Uint8Array.from({ length }, (_, i) => i % 256)]);
const all = (length: number): number[] => Array.from({ length }, (_, i) => i % 256);

function options(overrides: Partial<Parameters<typeof sendInChunks>[3]> = {}) {
  const progress: number[] = [];
  const sessions: string[] = [];
  return {
    progress,
    sessions,
    value: {
      signal: new AbortController().signal,
      onSession: (id: string) => {
        sessions.push(id);
      },
      onProgress: (sent: number) => progress.push(sent),
      ...overrides,
    },
  };
}

describe("sendInChunks", () => {
  it("sends a file in chunks and completes it", async () => {
    const server = fakeServer(4);
    const { value, progress, sessions } = options();
    const done = await sendInChunks(server.fetch, file(10), "f.bin", value);

    expect(done.attachment.id).toBe("Au1");
    expect(sessions).toEqual(["u1"]);
    expect(server.bytesOf("u1")).toEqual(all(10));
    expect(server.calls).toEqual([
      "POST /uploads",
      "PATCH /uploads/u1?offset=0",
      "PATCH /uploads/u1?offset=4",
      "PATCH /uploads/u1?offset=8",
      "POST /uploads/u1/complete",
    ]);
    expect(progress).toEqual([0, 4, 8, 10]);
  });

  it("persists a new session before sending its first byte", async () => {
    const server = fakeServer(4);
    let release!: () => void;
    const persisted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = sendInChunks(
      server.fetch,
      file(4),
      "f.bin",
      options({ onSession: () => persisted }).value,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(server.calls).toEqual(["POST /uploads"]);
    release();
    await pending;
    expect(server.calls).toContain("PATCH /uploads/u1?offset=0");
  });

  it("carries on an upload it is given from where the server is", async () => {
    const server = fakeServer(4);
    // An earlier visit got the first chunk up.
    server.sessions.set("u9", { size: 10, bytes: all(4) });

    const { value, sessions } = options({ uploadId: "u9" });
    await sendInChunks(server.fetch, file(10), "f.bin", value);
    expect(sessions).toEqual([]);
    expect(server.calls[0]).toBe("GET /uploads/u9");
    expect(server.calls[1]).toBe("PATCH /uploads/u9?offset=4");
    expect(server.bytesOf("u9")).toEqual(all(10));
  });

  it("opens a new upload when the one it was given is gone", async () => {
    const server = fakeServer(4);
    const { value, sessions } = options({ uploadId: "swept" });
    await sendInChunks(server.fetch, file(6), "f.bin", value);
    expect(sessions).toEqual(["u1"]);
    expect(server.bytesOf("u1")).toEqual(all(6));
  });

  it("asks where it is when a chunk's answer was lost, and does not send it twice", async () => {
    const server = fakeServer(4);
    let once = true;
    server.breakWhen((method, path) => {
      if (method === "PATCH" && path.endsWith("offset=4") && once) {
        once = false;
        return "after";
      }
      return undefined;
    });
    const { value } = options();
    // The lost answer looks like no connection: the caller's to retry.
    await expect(sendInChunks(server.fetch, file(10), "f.bin", value)).rejects.toMatchObject({ status: 0 });

    // The retry picks the same upload up, past the chunk the server did store.
    const retry = options({ uploadId: "u1" });
    await sendInChunks(server.fetch, file(10), "f.bin", retry.value);
    expect(server.bytesOf("u1")).toEqual(all(10));
    expect(server.calls.filter((call) => call.endsWith("offset=4"))).toHaveLength(1);
  });

  it("follows the server back after a 409", async () => {
    const server = fakeServer(4);
    let rewound = false;
    server.breakWhen((method) => {
      // The server lost the second chunk: it says so at completion.
      if (method === "POST" && !rewound && server.sessions.get("u1")?.bytes.length === 10) {
        rewound = true;
        const session = server.sessions.get("u1");
        if (session) session.bytes.length = 4;
      }
      return undefined;
    });
    const { value } = options();
    const done = await sendInChunks(server.fetch, file(10), "f.bin", value);
    expect(done.attachment.id).toBe("Au1");
    expect(server.bytesOf("u1")).toEqual(all(10));
  });

  it("stops at an abort", async () => {
    const server = fakeServer(4);
    const controller = new AbortController();
    const { value } = options({
      signal: controller.signal,
      onProgress: (sent) => {
        if (sent >= 4) controller.abort();
      },
    });
    await expect(sendInChunks(server.fetch, file(10), "f.bin", value)).rejects.toThrow();
    expect(server.bytesOf("u1")).toHaveLength(4);
  });

  it("passes on what it cannot recover from", async () => {
    const server = fakeServer(4);
    server.breakWhen(() => undefined);
    const tooBig: Fetch = async (path, init) => {
      if (path === "/uploads") throw Object.assign(new Error("too large"), { status: 413 });
      return server.fetch(path, init);
    };
    await expect(sendInChunks(tooBig, file(10), "f.bin", options().value)).rejects.toMatchObject({ status: 413 });
  });
});

describe("Throughput", () => {
  it("has no estimate until bytes have moved, then smooths the speed", () => {
    let now = 0;
    const speed = new Throughput(() => now);
    speed.sample(0);
    expect(speed.secondsLeft(1000)).toBeUndefined();
    now = 1000;
    speed.sample(1000); // 1000 B/s
    expect(speed.secondsLeft(5000)).toBeCloseTo(5);
    now = 2000;
    speed.sample(3000); // 2000 B/s, smoothed toward it
    expect(speed.secondsLeft(1300)).toBeCloseTo(1);
    speed.reset();
    expect(speed.secondsLeft(1000)).toBeUndefined();
  });
});

describe("formatting", () => {
  it("writes sizes", () => {
    expect(formatBytes(12)).toBe("12 bytes");
    expect(formatBytes(980_000)).toBe("980 KB");
    expect(formatBytes(12_400_000)).toBe("12.4 MB");
    expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
  });

  it("writes the time left", () => {
    expect(formatTimeLeft(2)).toBe("a few seconds left");
    expect(formatTimeLeft(41.2)).toBe("42 s left");
    expect(formatTimeLeft(200)).toBe("3 min 20 s left");
    expect(formatTimeLeft(900)).toBe("15 min left");
    expect(formatTimeLeft(3900)).toBe("1 h 5 min left");
  });
});
