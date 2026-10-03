import { describe, expect, it } from "vitest";

import type { KernelEvent } from "@kernel";

import type { PluginAdminView } from "./api.js";
import { createUpdateStore, installedFrom, parseUpdate, type ReportedUpdate } from "./updates.js";

const event = (payload: unknown): KernelEvent<unknown> => ({
  type: "admin:update-available",
  payload,
  origin: { kind: "plugin", id: "gitlab-packages" },
  at: 0,
});

const update = (plugin: string, source = "gitlab"): ReportedUpdate => ({
  plugin,
  source,
  current: "1.0.0",
  latest: "1.1.0",
  url: `https://example.com/${plugin}.zip`,
  reportedBy: "gitlab-packages",
});

describe("parseUpdate", () => {
  it("accepts a well-formed update and records who reported it", () => {
    const { reportedBy, ...payload } = update("tasks");
    expect(parseUpdate(event(payload))).toEqual({ ...payload, reportedBy });
  });

  it("ignores a malformed payload", () => {
    expect(parseUpdate(event({ plugin: "tasks" }))).toBeUndefined();
    expect(parseUpdate(event(undefined))).toBeUndefined();
  });
});

describe("createUpdateStore", () => {
  it("keeps one update per plugin, forgets one, and clears by source", () => {
    const store = createUpdateStore();
    let changes = 0;
    store.subscribe(() => changes++);
    store.report(update("a"));
    store.report(update("b", "other"));
    store.report(update("a"));
    expect([...store.get().keys()]).toEqual(["a", "b"]);
    store.forget("a");
    expect([...store.get().keys()]).toEqual(["b"]);
    store.clear("gitlab");
    expect([...store.get().keys()]).toEqual(["b"]);
    store.clear();
    expect(store.get().size).toBe(0);
    expect(changes).toBe(6);
  });
});

describe("installedFrom", () => {
  it("lists only plugins a source installed", () => {
    const plugins = [
      { id: "a", version: "1.0.0", source: { kind: "remote", url: "https://g/a.zip", via: "gitlab" } },
      { id: "b", version: "1.0.0", source: { kind: "upload", filename: "b.zip" } },
      { id: "c", version: "2.0.0", source: { kind: "remote", url: "https://r/c.zip", via: "releases" } },
    ] as unknown as PluginAdminView[];
    expect(installedFrom(plugins, "gitlab")).toEqual([
      { id: "a", version: "1.0.0", url: "https://g/a.zip" },
    ]);
  });
});
