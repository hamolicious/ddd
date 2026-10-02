import { afterEach, describe, expect, it, vi } from "vitest";

import { SUPPORTED_BRIDGE_VERSION } from "@kernel";

import { CapabilitiesHost, detectBridge } from "./capabilities.js";

const globals = globalThis as { shell?: unknown };

afterEach(() => {
  delete globals.shell;
});

describe("bridge detection", () => {
  it("ignores anything that is not a versioned object", () => {
    expect(detectBridge()).toBeUndefined();
    globals.shell = "yes";
    expect(detectBridge()).toBeUndefined();
    globals.shell = {};
    expect(detectBridge()).toBeUndefined();
    globals.shell = { version: "1" };
    expect(detectBridge()).toBeUndefined();
  });

  it("refuses a shell whose major is newer than this bundle", () => {
    globals.shell = { version: SUPPORTED_BRIDGE_VERSION + 1 };
    expect(detectBridge()).toBeUndefined();
    globals.shell = { version: SUPPORTED_BRIDGE_VERSION };
    expect(detectBridge()).toEqual({ version: SUPPORTED_BRIDGE_VERSION });
  });
});

describe("no bridge", () => {
  it("serves the browser fallbacks and says so", () => {
    const host = new CapabilitiesHost(undefined);
    expect(host.bridgeVersion).toBeUndefined();
    expect(host.notifications.supportsScheduled).toBe(false);
    expect(host.support("filesystem")).toBe("unavailable");
    expect(host.has("filesystem")).toBe(false);
  });

  it("refuses to pretend a browser can schedule a notification", async () => {
    const host = new CapabilitiesHost(undefined);
    await expect(host.notifications.schedule({ title: "x" }, Date.now() + 1000)).rejects.toThrow(
      /shell/,
    );
  });
});

describe("with a bridge", () => {
  it("routes through it, base64-encoding bytes for the JSON boundary", async () => {
    const exported: unknown[] = [];
    const host = new CapabilitiesHost({
      version: 1,
      filesystem: { export: (file: unknown) => void exported.push(file) },
    });
    expect(host.support("filesystem")).toBe("native");
    await host.filesystem.export({
      name: "notes.md",
      mime: "text/markdown",
      bytes: new Uint8Array([104, 105]),
    });
    expect(exported).toEqual([{ name: "notes.md", mime: "text/markdown", data: "aGk=" }]);
  });

  it("hands back picked files whose bytes came over the bridge", async () => {
    const host = new CapabilitiesHost({
      version: 1,
      filesystem: {
        pick: () => Promise.resolve([{ name: "a.md", mime: "text/markdown", size: 2, data: "aGk=" }]),
      },
    });
    const [file] = await host.filesystem.pick({ accept: [".md"] });
    expect(file?.name).toBe("a.md");
    expect(await file?.text()).toBe("hi");
    expect([...((await file?.bytes()) ?? [])]).toEqual([104, 105]);
  });

  it("falls back per method for what the bridge does not implement", async () => {
    const host = new CapabilitiesHost({
      version: 1,
      filesystem: { export: () => Promise.resolve() },
    });
    await expect(host.filesystem.pick()).rejects.toThrow(/unavailable/);
  });

  it("reports a bridge method that throws rather than doing the thing twice", async () => {
    const fallback = vi.fn();
    const host = new CapabilitiesHost({
      version: 1,
      notifications: {
        notify: () => Promise.reject(new Error("no permission")),
      },
    });
    await expect(host.notifications.notify({ title: "x" })).rejects.toThrow("no permission");
    expect(fallback).not.toHaveBeenCalled();
  });

  it("only claims scheduling when it can also cancel", async () => {
    const half = new CapabilitiesHost({ version: 1, notifications: { schedule: () => "1" } });
    expect(half.notifications.supportsScheduled).toBe(false);
    await expect(half.notifications.schedule({ title: "x" }, 0)).rejects.toThrow(/shell/);

    const scheduled: [unknown, number][] = [];
    const full = new CapabilitiesHost({
      version: 1,
      notifications: {
        schedule: (notification: unknown, at: number) => {
          scheduled.push([notification, at]);
          return Promise.resolve("sched-1");
        },
        cancel: () => Promise.resolve(),
        scheduled: () => Promise.resolve([{ id: "sched-1", at: 42 }, { id: 5 }]),
      },
    });
    expect(full.notifications.supportsScheduled).toBe(true);
    expect(await full.notifications.schedule({ title: "Reminder" }, 42)).toBe("sched-1");
    expect(scheduled).toEqual([[{ title: "Reminder" }, 42]]);
    expect(await full.notifications.scheduled()).toEqual([{ id: "sched-1", at: 42 }]);
  });

  it("treats a nonsense permission answer as unknown rather than granted", () => {
    const host = new CapabilitiesHost({
      version: 1,
      notifications: { notify: () => undefined, permission: () => "sure" },
    });
    expect(host.notifications.permission()).toBe("default");
  });
});
