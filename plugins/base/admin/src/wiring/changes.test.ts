import { describe, expect, it } from "vitest";

import type { ApplyPlan } from "@kernel";

import { summarize } from "./changes.js";
import { EMPTY_OVERRIDES } from "./draft.js";

const plan = (patch: Partial<ApplyPlan>): ApplyPlan => ({
  changes: [],
  stop: [],
  start: [],
  restart: [],
  hosts: [],
  cold: [],
  alsoStops: [],
  alsoStarts: [],
  addedErrors: 0,
  ...patch,
});

describe("summarize", () => {
  it("turns the plan's changes into rows with a target to select", () => {
    const out = summarize(
      plan({
        changes: [
          { kind: "unplug", plugin: "sync-status" },
          { kind: "bind", port: "graph:index", from: "indexer:index", to: "acme:index" },
          { kind: "seats", port: "shell-ui:sidebar", seats: ["doc-list:list", "folders:tree", "acme:panel"], added: ["acme:panel"], removed: ["changes:panel"] },
          { kind: "listen", port: "doc-list:location", added: ["acme:location"], removed: [] },
        ],
        stop: ["sync-status"],
        restart: ["graph"],
        hosts: ["shell-ui:sidebar", "doc-list:location"],
      }),
      EMPTY_OVERRIDES,
      { ...EMPTY_OVERRIDES, unplugged: ["sync-status"], bind: { "graph:index": "acme:index" } },
      "wiring",
    );
    expect(out.rows).toEqual([
      { op: "del", text: "unplug sync-status", node: "sync-status" },
      { op: "mod", text: "graph:index: indexer → acme", port: "graph:index" },
      { op: "mod", text: "shell-ui:sidebar seats: 1 doc-list, 2 folders, 3 acme (new); removed changes", port: "shell-ui:sidebar" },
      { op: "add", text: "acme:location → doc-list:location", port: "doc-list:location" },
    ]);
    expect(out.steps).toEqual(["stop · sync-status", "restart · graph", "update · shell-ui:sidebar, doc-list:location"]);
    expect(out.stopsEditor).toBe(false);
  });

  it("names edits the plan is silent about: a pin to the automatic pick, a cut of an inactive wire", () => {
    const out = summarize(plan({}), EMPTY_OVERRIDES, { ...EMPTY_OVERRIDES, bind: { "graph:index": null }, cut: ["a:x -> b:y"] }, "wiring");
    expect(out.rows).toEqual([
      { op: "mod", text: "graph:index: unbound", port: "graph:index" },
      { op: "del", text: "cut a:x -> b:y" },
    ]);
  });

  it("a cold plugin replaces the steps with a reload, and stopping the editor is flagged", () => {
    const out = summarize(plan({ stop: ["router", "wiring"], alsoStops: ["wiring", "admin"], cold: ["alt-editor"], addedErrors: 2 }), EMPTY_OVERRIDES, EMPTY_OVERRIDES, "wiring");
    expect(out.steps).toEqual(["reload · alt-editor"]);
    expect(out.stopsEditor).toBe(true);
    expect(out.addedErrors).toBe(2);
    expect(out.alsoStops).toEqual(["wiring", "admin"]);
  });
});
