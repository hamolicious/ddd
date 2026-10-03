import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Kernel } from "@kernel";

import { preferenceStore } from "./prefs.js";

function slowKernel(): { kernel: Kernel; land(): void } {
  const values = new Map<string, string>();
  const waiting: (() => void)[] = [];
  const kernel = {
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    settings: {
      get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
      set: (key: string, value: unknown): Promise<void> =>
        new Promise<void>((resolve) => {
          waiting.push(() => {
            values.set(key, String(value));
            resolve();
          });
        }),
      subscribe: () => () => undefined,
    },
  } as unknown as Kernel;
  return {
    kernel,
    land: () => {
      for (const done of waiting.splice(0)) done();
    },
  };
}

describe("preferenceStore", () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it("keeps a choice made just before a reload, while the server has not answered yet", async () => {
    const { kernel, land } = slowKernel();
    const before = preferenceStore(kernel, "themes");
    void before.set("dark", "midnight");
    expect(before.durable).toBe(true);

    const reloaded = preferenceStore(kernel, "themes");
    expect(reloaded.get("dark")).toBe("midnight");
    expect(reloaded.durable).toBe(false);

    const flushed = reloaded.flush();
    land();
    await flushed;
    land();
    await Promise.resolve();
    expect(kernel.settings.get("dark")).toBe("midnight");
    expect(reloaded.durable).toBe(true);
  });
});
