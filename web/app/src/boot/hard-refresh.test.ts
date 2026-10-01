import { afterEach, describe, expect, it, vi } from "vitest";

import { hardRefresh, type HardRefreshDeps } from "./hard-refresh.js";

const SESSION_KEY = "life-manager.boot.session";
const PLUGINS_KEY = "life-manager.boot.plugins";

function memoryStorage(entries: Record<string, string>): Storage {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

function setup(options: { failingCache?: string } = {}) {
  const order: string[] = [];
  const registrations = ["a", "b"].map((name) => ({
    unregister: vi.fn(async () => {
      order.push(`unregister:${name}`);
      return true;
    }),
  }));
  const names = ["workbox-precache-v2", "lm-plugins", "lm-runtime", "lm-meta", "lm-shell"];
  const caches = {
    keys: vi.fn(async () => names),
    delete: vi.fn(async (key: string) => {
      order.push(`delete:${key}`);
      if (key === options.failingCache) throw new Error("refused");
      return true;
    }),
  };
  const serviceWorker = {
    getRegistrations: vi.fn(async () => registrations as unknown as readonly ServiceWorkerRegistration[]),
  };
  const reload = vi.fn(() => order.push("reload"));
  return { order, registrations, names, caches, serviceWorker, reload, warn: vi.fn() };
}

describe("hard refresh", () => {
  const original = globalThis.localStorage;
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
  });

  function storageWith(): Storage {
    const storage = memoryStorage({
      [SESSION_KEY]: "{}",
      [PLUGINS_KEY]: "{}",
      "life-manager.shell.token": "t",
      "life-manager.storage-persist": "asked",
      other: "x",
    });
    Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
    return storage;
  }

  it("unregisters every worker, deletes every cache, drops only the boot keys, then reloads", async () => {
    const storage = storageWith();
    const t = setup();
    await hardRefresh({ serviceWorker: t.serviceWorker, caches: t.caches, reload: t.reload, warn: t.warn });

    for (const registration of t.registrations) expect(registration.unregister).toHaveBeenCalledOnce();
    expect(t.caches.delete.mock.calls.map(([key]) => key)).toEqual(t.names);
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(storage.getItem(PLUGINS_KEY)).toBeNull();
    expect(storage.getItem("life-manager.shell.token")).toBe("t");
    expect(storage.getItem("life-manager.storage-persist")).toBe("asked");
    expect(storage.getItem("other")).toBe("x");
    expect(t.reload).toHaveBeenCalledOnce();
    expect(t.order.at(-1)).toBe("reload");
    expect(t.warn).not.toHaveBeenCalled();
  });

  it("still clears the rest and reloads without `caches` or service workers (insecure context)", async () => {
    const storage = storageWith();
    const t = setup();
    await hardRefresh({ serviceWorker: undefined, caches: undefined, reload: t.reload, warn: t.warn });
    expect(storage.getItem(SESSION_KEY)).toBeNull();
    expect(storage.getItem(PLUGINS_KEY)).toBeNull();
    expect(t.reload).toHaveBeenCalledOnce();
  });

  it("carries on past a step that throws, and reloads last", async () => {
    storageWith();
    const t = setup({ failingCache: "lm-plugins" });
    const forget = vi.fn(() => {
      throw new Error("storage blocked");
    });
    const deps: HardRefreshDeps = {
      serviceWorker: { getRegistrations: vi.fn(async () => Promise.reject(new Error("blocked"))) },
      caches: t.caches,
      forgetBootCache: forget,
      reload: t.reload,
      warn: t.warn,
    };
    await hardRefresh(deps);
    // Every cache was attempted, the failed one included.
    expect(t.caches.delete).toHaveBeenCalledTimes(t.names.length);
    expect(forget).toHaveBeenCalledOnce();
    expect(t.warn).toHaveBeenCalledTimes(3);
    expect(t.order.at(-1)).toBe("reload");
  });
});
