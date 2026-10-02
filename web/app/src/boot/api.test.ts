import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, OfflineError, inviteTokenFromHash, me, resetTokenFromHash } from "./api.js";

const originalFetch = globalThis.fetch;

let calls: RequestInit[] = [];

const lastInit = (): RequestInit => {
  const init = calls.at(-1);
  if (!init) throw new Error("fetch was not called");
  return init;
};

const answerWith = (impl: (init: RequestInit) => Promise<Response>): void => {
  globalThis.fetch = vi.fn(async (_input: unknown, init: RequestInit = {}) => {
    calls.push(init);
    return impl(init);
  }) as unknown as typeof fetch;
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("every pre-kernel call carries a deadline", () => {
  it("passes an AbortSignal that is not already aborted", async () => {
    answerWith(async () => json({ id: "u1", email: "a@example.com" }));

    await me();

    const signal = lastInit().signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("reads an aborted request as offline, never as a failed boot", async () => {
    answerWith(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });

    await expect(me()).rejects.toBeInstanceOf(OfflineError);
  });

  it("still tells a server that answered apart from one that did not", async () => {
    answerWith(async () => json({ error: { code: "unauthorized" } }, 401));
    await expect(me()).resolves.toBeUndefined();

    answerWith(async () => json({ error: { code: "server_error" } }, 500));
    await expect(me()).rejects.toBeInstanceOf(ApiError);
  });
});

describe("resetTokenFromHash", () => {
  it("reads the token out of a reset link", () => {
    expect(resetTokenFromHash("#/reset/Ab_c-9")).toBe("Ab_c-9");
  });

  it("ignores every other address", () => {
    expect(resetTokenFromHash("")).toBeUndefined();
    expect(resetTokenFromHash("#/doc/01J")).toBeUndefined();
    expect(resetTokenFromHash("#/reset/")).toBeUndefined();
    expect(resetTokenFromHash("#/reset/a/b")).toBeUndefined();
  });
});

describe("inviteTokenFromHash", () => {
  it("reads the token out of an invite link", () => {
    expect(inviteTokenFromHash("#/invite/Ab_c-9")).toBe("Ab_c-9");
  });

  it("ignores every other address", () => {
    expect(inviteTokenFromHash("#/reset/Ab_c-9")).toBeUndefined();
    expect(inviteTokenFromHash("#/invite/")).toBeUndefined();
    expect(inviteTokenFromHash("#/invite/a/b")).toBeUndefined();
  });
});
