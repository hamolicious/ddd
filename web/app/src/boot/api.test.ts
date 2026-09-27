/**
 * The two pre-kernel REST calls, and the deadline on them.
 *
 * The deadline is the interesting part and the reason this file exists. `me()` and
 * `installedPlugins()` are the only network in the boot sequence, and inside the Flutter
 * shell that sequence is racing a 25 s native watchdog whose expiry is counted as a
 * *failed boot* (`app/BRIDGE.md` §7). Without a deadline these calls inherit the platform
 * default — minutes, on a captive portal, a half-open TCP connection, a VPN handshake, or
 * a server that accepts and then stalls — so the watchdog fires first and a bundle that
 * was merely waiting on the network gets declared broken. Two such launches and the shell
 * reverts to the previous bundle and quarantines the working one.
 *
 * The right answer to a stall is the offline path, not a failure: `OfflineError` boots the
 * local workspace from the remembered session and lets the socket re-auth later
 * (SPEC §4.1, §5.3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, OfflineError, inviteTokenFromHash, me, resetTokenFromHash } from "./api.js";

const originalFetch = globalThis.fetch;

let calls: RequestInit[] = [];

/** The last `RequestInit` `call()` handed to `fetch`. */
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
    // What a timeout looks like from `fetch`: a rejection, indistinguishable from any
    // other transport failure — which is exactly the classification we want.
    answerWith(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });

    await expect(me()).rejects.toBeInstanceOf(OfflineError);
  });

  it("still tells a server that answered apart from one that did not", async () => {
    answerWith(async () => json({ error: { code: "unauthorized" } }, 401));
    // 401 is the one authoritative "your session is over" and must reach the login form,
    // not the offline workspace.
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
