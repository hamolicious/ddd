/**
 * The four registry behaviours SPEC §6.4 names, pinned. Everything else in the
 * runtime is a wrapper; this is the part with semantics of its own.
 */

import { describe, expect, it, vi } from "vitest";

import { ContractViolationError, s } from "@kernel";

import { ExtensionRegistry } from "./registry.js";

interface Item {
  readonly id: string;
  readonly label: string;
}

const itemShape = s.object({ id: s.string(), label: s.string() });

describe("ExtensionRegistry", () => {
  it("buffers contributions to an undefined point and delivers them on definition", () => {
    const registry = new ExtensionRegistry();
    registry.contribute("early", "navbar.item", { id: "a", label: "A" });

    expect(registry.get("navbar.item")).toHaveLength(1);
    expect(registry.pending()).toHaveLength(1);

    const point = registry.definePoint<Item>("shell-ui", { name: "navbar.item", shape: itemShape });
    expect(point.get()).toEqual([{ id: "a", label: "A" }]);
    expect(registry.pending()).toHaveLength(0);
  });

  it("throws on a duplicate definePoint, naming the existing owner", () => {
    const registry = new ExtensionRegistry();
    registry.definePoint("shell-ui", { name: "navbar.item" });
    expect(() => registry.definePoint("impostor", { name: "navbar.item" })).toThrow(
      ContractViolationError,
    );
    expect(registry.owner("navbar.item")).toBe("shell-ui");
  });

  it("is live: subscribe fires immediately and again on every change", () => {
    const registry = new ExtensionRegistry();
    registry.definePoint<Item>("shell-ui", { name: "navbar.item", shape: itemShape });
    const seen = vi.fn();
    const stop = registry.subscribe<Item>("navbar.item", seen);

    expect(seen).toHaveBeenCalledWith([]);
    const handle = registry.contribute("docs", "navbar.item", { id: "a", label: "A" });
    expect(seen).toHaveBeenLastCalledWith([{ id: "a", label: "A" }]);
    handle.dispose();
    expect(seen).toHaveBeenLastCalledWith([]);

    stop();
    registry.contribute("docs", "navbar.item", { id: "b", label: "B" });
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("rejects a malformed contribution loudly, at the contributor", () => {
    const registry = new ExtensionRegistry();
    registry.definePoint<Item>("shell-ui", { name: "navbar.item", shape: itemShape });
    expect(() => registry.contribute("docs", "navbar.item", { id: 7 })).toThrow(
      /malformed: id: expected string, got number; label: expected string, got undefined/,
    );
    expect(registry.get("navbar.item")).toHaveLength(0);
  });

  it("drops a malformed buffered contribution at definition time and reports it", () => {
    const reports: string[] = [];
    const registry = new ExtensionRegistry((report) => reports.push(`${report.pluginId}:${report.point}`));
    registry.contribute("docs", "navbar.item", { id: 7 });
    registry.definePoint<Item>("shell-ui", { name: "navbar.item", shape: itemShape });

    expect(registry.get("navbar.item")).toHaveLength(0);
    expect(reports).toEqual(["docs:navbar.item"]);
  });

  it("orders by `order`, then by contribution sequence", () => {
    const registry = new ExtensionRegistry();
    registry.definePoint<Item>("shell-ui", { name: "navbar.item", shape: itemShape });
    registry.contribute("a", "navbar.item", { id: "second", label: "" }, { order: 100 });
    registry.contribute("b", "navbar.item", { id: "first", label: "" }, { order: 10 });
    registry.contribute("c", "navbar.item", { id: "third", label: "" }, { order: 100 });

    expect(registry.get<Item>("navbar.item").map((item) => item.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("first registration wins on a duplicate key, and the loser is reported", () => {
    const reports: string[] = [];
    const registry = new ExtensionRegistry((report) => reports.push(report.message));
    registry.definePoint<Item>("commands", {
      name: "commands.command",
      shape: itemShape,
      key: (item) => item.id,
    });
    registry.contribute("docs", "commands.command", { id: "open", label: "Open" });
    registry.contribute("other", "commands.command", { id: "open", label: "Open too" });

    expect(registry.get<Item>("commands.command")).toEqual([{ id: "open", label: "Open" }]);
    expect(reports[0]).toMatch(/Two plugins claim “open”/);
  });

  it("applies the duplicate-key rule to buffered contributions too", () => {
    // Buffering is how a plugin contributes before its point's owner has loaded, so
    // the key rule has to survive it — otherwise "first registration wins" becomes
    // "whoever loaded before the point owner wins twice".
    const reports: string[] = [];
    const registry = new ExtensionRegistry((report) => reports.push(report.message));
    registry.contribute("docs", "commands.command", { id: "open", label: "Open" });
    registry.contribute("other", "commands.command", { id: "open", label: "Open too" });
    registry.contribute("third", "commands.command", { id: "close", label: "Close" });
    registry.definePoint<Item>("commands", {
      name: "commands.command",
      shape: itemShape,
      key: (item) => item.id,
    });

    expect(registry.get<Item>("commands.command")).toEqual([
      { id: "open", label: "Open" },
      { id: "close", label: "Close" },
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/Two plugins claim “open”\. docs is being used\./);
  });

  it("removePlugin withdraws everything a failed plugin contributed", () => {
    const registry = new ExtensionRegistry();
    registry.definePoint<Item>("shell-ui", { name: "navbar.item", shape: itemShape });
    registry.contribute("doomed", "navbar.item", { id: "a", label: "A" });
    registry.contribute("fine", "navbar.item", { id: "b", label: "B" });

    registry.removePlugin("doomed");
    expect(registry.get<Item>("navbar.item").map((item) => item.id)).toEqual(["b"]);
  });

  it("removePlugin releases the points the plugin defined, so a replacement can claim them", () => {
    // The loader calls `retract` when `activate()` throws, and a plugin that defined a
    // point *before* throwing must not leave the registry half-claimed: `isDefined`
    // answering `true` for a dead owner makes every dependent's feature detection lie,
    // and a duplicate `definePoint` throws — so nothing could ever claim the name again.
    const registry = new ExtensionRegistry();
    registry.definePoint<Item>("commands", { name: "commands.command", shape: itemShape });
    expect(registry.isDefined("commands.command")).toBe(true);

    registry.removePlugin("commands");

    expect(registry.isDefined("commands.command")).toBe(false);
    expect(registry.owner("commands.command")).toBeUndefined();
    expect(registry.points()).not.toContain("commands.command");
    // And a replacement can define it, rather than being locked out for the session.
    expect(() =>
      registry.definePoint<Item>("commands-next", { name: "commands.command", shape: itemShape }),
    ).not.toThrow();
    expect(registry.owner("commands.command")).toBe("commands-next");
  });

  it("re-buffers contributions to a released point so the next owner receives them", () => {
    const registry = new ExtensionRegistry();
    registry.definePoint<Item>("commands", { name: "commands.command", shape: itemShape });
    registry.contribute("doc-list", "commands.command", { id: "new", label: "New document" });

    registry.removePlugin("commands");
    expect(registry.pending().map((entry) => entry.pluginId)).toEqual(["doc-list"]);

    const point = registry.definePoint<Item>("commands-next", {
      name: "commands.command",
      shape: itemShape,
    });
    expect(point.get()).toEqual([{ id: "new", label: "New document" }]);
  });

  it("isolates a throwing subscriber: later subscribers still hear, and contribute does not throw", () => {
    // One plugin's bad listener used to (1) stop every listener registered after it —
    // silently freezing the navbar for the rest of the session — and (2) escape into
    // the *contributing* plugin's `activate()`, so the loader failed an innocent plugin
    // and skipped its dependents with an error message naming somebody else's bug.
    const reports: { pluginId: string; message: string }[] = [];
    const registry = new ExtensionRegistry((report) =>
      reports.push({ pluginId: report.pluginId, message: report.message }),
    );
    registry.definePoint<Item>("shell-ui", { name: "navbar.item", shape: itemShape });

    const broken = registry.forPlugin("broken");
    broken.subscribe<Item>("navbar.item", (items) => {
      if (items.length > 0) throw new Error("bang");
    });
    const seen = vi.fn();
    registry.forPlugin("shell-ui").subscribe<Item>("navbar.item", seen);

    expect(() =>
      registry.forPlugin("doc-list").contribute("navbar.item", { id: "a", label: "A" }),
    ).not.toThrow();
    expect(seen).toHaveBeenLastCalledWith([{ id: "a", label: "A" }]);
    expect(reports).toEqual([
      { pluginId: "broken", message: expect.stringContaining("a subscriber threw") },
    ]);
  });

  it("attributes contributions to the calling plugin, not to a caller-supplied id", () => {
    const registry = new ExtensionRegistry();
    registry.definePoint<Item>("shell-ui", { name: "navbar.item", shape: itemShape });
    const kernelForDocs = registry.forPlugin("doc-list");
    kernelForDocs.contribute("navbar.item", { id: "a", label: "A" });

    expect(registry.entries("navbar.item")[0]?.pluginId).toBe("doc-list");
  });
});
