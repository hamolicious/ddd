import { describe, expect, it, vi } from "vitest";

import type { DocumentRow } from "@kernel";

import type { DocumentMode } from "./api.js";
import {
  claimedModeId,
  DEFAULT_MODE_ID,
  MODE_MEMORY_CAP,
  nextModeId,
  parseModeMemory,
  rememberMode,
  resolveModeId,
  serializeModeMemory,
  visibleModes,
} from "./modes.js";

const mode = (id: string, extra: Partial<DocumentMode> = {}): DocumentMode => ({
  id,
  label: id,
  component: () => null,
  ...extra,
});

const row = (overrides: Partial<DocumentRow> = {}): DocumentRow => ({
  id: "01J000000000000000000000",
  title: "Doc",
  content: "# Doc\n",
  fm: {},
  plugins: {},
  fm_parse_error: false,
  materialized_version: "v1",
  created_at: "2026-01-01T00:00:00.000Z",
  created_by: null,
  updated_at: "2026-01-01T00:00:00.000Z",
  updated_by: null,
  deleted: false,
  deleted_at: null,
  deleted_by: null,
  purged: false,
  ...overrides,
});

describe("visibleModes", () => {
  it("keeps modes without a `when`", () => {
    expect(visibleModes([mode("read"), mode("edit")], row()).map((entry) => entry.id)).toEqual([
      "read",
      "edit",
    ]);
  });

  it("keeps the registry's order and does not sort by `order` again", () => {
    // The registry already sorted; the switch shows exactly what it hands over.
    const seated = [mode("late", { order: 500 }), mode("plain"), mode("early", { order: 0 })];
    expect(visibleModes(seated, row()).map((entry) => entry.id)).toEqual(["late", "plain", "early"]);
  });

  it("hides a mode whose `when` returns false", () => {
    const modes = [mode("read"), mode("attachment", { when: (candidate) => candidate.fm.kind === "file" })];
    expect(visibleModes(modes, row()).map((entry) => entry.id)).toEqual(["read"]);
    expect(visibleModes(modes, row({ fm: { kind: "file" } })).map((entry) => entry.id)).toEqual([
      "read",
      "attachment",
    ]);
  });

  it("shows every mode while the row is still unknown", () => {
    const modes = [mode("read"), mode("attachment", { when: () => false })];
    expect(visibleModes(modes, undefined)).toHaveLength(2);
  });

  it("fails closed on a throwing `when`, and reports it", () => {
    const onError = vi.fn();
    const broken = mode("broken", {
      when: () => {
        throw new Error("nope");
      },
    });
    expect(visibleModes([mode("read"), broken], row(), onError).map((entry) => entry.id)).toEqual([
      "read",
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(broken);
  });
});

describe("resolveModeId", () => {
  const visible = [mode("read", { order: 0 }), mode("edit", { order: 10 })];

  it("prefers the document's remembered mode", () => {
    expect(resolveModeId("edit", "read", visible)).toBe("edit");
  });

  it("falls back to the user's default when nothing is remembered", () => {
    expect(resolveModeId(undefined, "edit", visible)).toBe("edit");
  });

  it("ignores a remembered mode that is no longer registered", () => {
    expect(resolveModeId("outline", "edit", visible)).toBe("edit");
  });

  it("falls back to `read` when neither preference is available", () => {
    expect(resolveModeId(undefined, undefined, visible)).toBe(DEFAULT_MODE_ID);
  });

  it("falls back to the first seated visible mode when `read` is not wired in", () => {
    // `write` has the lower `order` hint, but the seat order is what counts.
    const replaced = [mode("preview", { order: 5 }), mode("write", { order: 1 })];
    expect(resolveModeId("read", "read", replaced)).toBe("preview");
  });

  it("is undefined when nothing at all is registered", () => {
    expect(resolveModeId("read", "edit", [])).toBeUndefined();
  });
});

describe("per-document claims", () => {
  const isCanvas = (candidate: DocumentRow): boolean => candidate.fm.type === "canvas";
  const visible = [mode("read"), mode("edit"), mode("canvas", { prefer: isCanvas })];

  it("finds the mode that claims the document", () => {
    expect(claimedModeId(visible, row({ fm: { type: "canvas" } }))).toBe("canvas");
    expect(claimedModeId(visible, row())).toBeUndefined();
    expect(claimedModeId(visible, undefined)).toBeUndefined();
  });

  it("takes the first claimant in seat order", () => {
    const both = [mode("a", { prefer: () => true }), mode("b", { prefer: () => true })];
    expect(claimedModeId(both, row())).toBe("a");
  });

  it("treats a `prefer` that throws as no claim, and reports it", () => {
    const onError = vi.fn();
    const broken = [mode("bad", { prefer: () => { throw new Error("boom"); } }), mode("good", { prefer: () => true })];
    expect(claimedModeId(broken, row(), onError)).toBe("good");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("outranks the user's default", () => {
    expect(resolveModeId(undefined, "edit", visible, "canvas")).toBe("canvas");
  });

  it("does not outrank the user's own switch on the document", () => {
    expect(resolveModeId("read", "edit", visible, "canvas")).toBe("read");
  });

  it("is ignored when the claiming mode is not visible", () => {
    expect(resolveModeId(undefined, "edit", visible.slice(0, 2), "canvas")).toBe("edit");
  });
});

describe("nextModeId", () => {
  const visible = [mode("read"), mode("edit"), mode("outline")];

  it("cycles in order and wraps", () => {
    expect(nextModeId(visible, "read")).toBe("edit");
    expect(nextModeId(visible, "outline")).toBe("read");
  });

  it("starts at the first mode when the current one is unknown", () => {
    expect(nextModeId(visible, undefined)).toBe("read");
    expect(nextModeId(visible, "gone")).toBe("read");
  });

  it("is undefined with no modes", () => {
    expect(nextModeId([], "read")).toBeUndefined();
  });
});

describe("mode memory", () => {
  it("round-trips through the settings list form", () => {
    const memory = parseModeMemory(["a=edit", "b=read"]);
    expect([...memory.entries()]).toEqual([
      ["a", "edit"],
      ["b", "read"],
    ]);
    expect(serializeModeMemory(memory)).toEqual(["a=edit", "b=read"]);
  });

  it("drops entries that are not `id=mode` strings", () => {
    const memory = parseModeMemory(["ok=read", "nokey", "=read", "b=", 42, null, "=" ]);
    expect([...memory.keys()]).toEqual(["ok"]);
  });

  it("is not a list at all, gracefully", () => {
    expect(parseModeMemory(undefined).size).toBe(0);
    expect(parseModeMemory("a=read").size).toBe(0);
    expect(parseModeMemory({ a: "read" }).size).toBe(0);
  });

  it("lets a later entry for the same document win, as the most recent", () => {
    const memory = parseModeMemory(["a=read", "b=read", "a=edit"]);
    expect(memory.get("a")).toBe("edit");
    expect([...memory.keys()]).toEqual(["b", "a"]);
  });

  it("moves a re-chosen document to the most recent slot", () => {
    const memory = rememberMode(parseModeMemory(["a=read", "b=read"]), "a", "edit");
    expect(serializeModeMemory(memory)).toEqual(["b=read", "a=edit"]);
  });

  it("evicts the oldest entries beyond the cap", () => {
    const memory = new Map<string, string>();
    for (let index = 0; index < MODE_MEMORY_CAP + 5; index++) {
      rememberMode(memory, `doc-${index}`, "read");
    }
    expect(memory.size).toBe(MODE_MEMORY_CAP);
    expect(memory.has("doc-0")).toBe(false);
    expect(memory.has(`doc-${MODE_MEMORY_CAP + 4}`)).toBe(true);
    expect(serializeModeMemory(memory)).toHaveLength(MODE_MEMORY_CAP);
  });

  it("caps the serialized form even when the map is longer", () => {
    const memory = new Map<string, string>();
    for (let index = 0; index < 10; index++) memory.set(`doc-${index}`, "read");
    expect(serializeModeMemory(memory, 3)).toEqual(["doc-7=read", "doc-8=read", "doc-9=read"]);
  });
});
