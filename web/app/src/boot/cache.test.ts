/**
 * The offline-boot fallback: the two facts a reload with no network needs, and the one
 * distinction the boot sequence has to get right.
 *
 * This is unit-tested rather than driven end to end because the e2e suite blocks service
 * workers (`playwright.app.config.ts` — their immutable plugin cache makes rebuilds lie),
 * and without one there is no offline navigation to reload into. What *is* testable here is
 * the whole of the logic that was missing: "the server said no" and "there is no server"
 * must not be the same answer, and what the last good boot remembered has to survive.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InstalledPlugin, SessionUser } from "@kernel";

import { ApiError, OfflineError, installedPlugins, me } from "./api.js";
import {
  cachedPlugins,
  cachedSession,
  forgetBootCache,
  forgetSession,
  rememberPlugins,
  rememberSession,
} from "./cache.js";

const USER: SessionUser = {
  id: "01J8ZUSER0000000000000000",
  email: "alice@example.com",
  name: null,
  isAdmin: true,
};

const PLUGIN = {
  manifest: { id: "shell-ui", version: "1.0.0", kernel: "^1.0" },
  baseUrl: "/plugins/shell-ui/1.0.0/",
  state: "enabled",
  base: true,
} as unknown as InstalledPlugin;

/** The `Storage` surface `cache.ts` uses, in memory (the suite runs on `node`). */
function installStorage(): void {
  const entries = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
    clear: () => entries.clear(),
  };
}

beforeEach(() => installStorage());

afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  vi.unstubAllGlobals();
});

describe("what the boot sequence remembers", () => {
  it("round-trips the session user and the installed set", () => {
    expect(cachedSession()).toBeUndefined();
    expect(cachedPlugins()).toBeUndefined();

    rememberSession(USER);
    rememberPlugins([PLUGIN]);

    expect(cachedSession()).toEqual(USER);
    expect(cachedPlugins()).toHaveLength(1);
    expect(cachedPlugins()?.[0]?.manifest.id).toBe("shell-ui");
  });

  it("forgets the session without forgetting the plugin list", () => {
    // A 401 means this session is over; it says nothing about what is installed, and the
    // next offline boot still needs a list to activate.
    rememberSession(USER);
    rememberPlugins([PLUGIN]);
    forgetSession();
    expect(cachedSession()).toBeUndefined();
    expect(cachedPlugins()).toHaveLength(1);
  });

  it("forgets everything on sign-out", () => {
    rememberSession(USER);
    rememberPlugins([PLUGIN]);
    forgetBootCache();
    expect(cachedSession()).toBeUndefined();
    expect(cachedPlugins()).toBeUndefined();
  });

  it("ignores a stale or corrupt entry rather than trusting it", () => {
    localStorage.setItem("life-manager.boot.session", "{not json");
    expect(cachedSession()).toBeUndefined();
    localStorage.setItem("life-manager.boot.session", JSON.stringify({ v: 99, user: USER }));
    expect(cachedSession()).toBeUndefined();
    localStorage.setItem("life-manager.boot.session", JSON.stringify({ v: 1, user: { id: 7 } }));
    expect(cachedSession()).toBeUndefined();
  });

  it("survives storage being unavailable", () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => rememberSession(USER)).not.toThrow();
    expect(cachedSession()).toBeUndefined();
    expect(() => forgetBootCache()).not.toThrow();
  });
});

describe("a server that answered vs no server at all", () => {
  it("maps a transport failure to OfflineError, not to a boot failure", async () => {
    // `fetch` rejects only when the request never got an answer — no network, or the
    // service worker's `NetworkOnly` route with nothing to reach. The boot sequence keys
    // its entire offline path off this distinction.
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    await expect(me()).rejects.toBeInstanceOf(OfflineError);
    await expect(installedPlugins()).rejects.toBeInstanceOf(OfflineError);
  });

  it("keeps 401 as 'not signed in' — the only authoritative answer", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: "unauthorized", message: "no session" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(me()).resolves.toBeUndefined();
  });

  it("keeps any other status an error, so a real fault is not mistaken for offline", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response("nope", { status: 500, statusText: "Server Error" })),
    );
    const failure = await me().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).not.toBeInstanceOf(OfflineError);
  });
});
