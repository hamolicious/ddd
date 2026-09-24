/**
 * The three keybinding rules of SPEC §6.5, pinned.
 *
 * "First registration wins on a conflict, and conflicts are listed" is the kind of rule
 * that quietly becomes "last wins" during a refactor, and nobody notices until two
 * plugins fight over `Mod+K` in someone else's workspace.
 */

import { describe, expect, it } from "vitest";

import { parseOverrides, resolveBindings, serializeOverrides } from "./bindings.js";
import type { KeybindingDefault } from "../../_shared/points.js";

const defaults = (...entries: readonly [string, string][]): readonly KeybindingDefault[] =>
  entries.map(([command, keys]) => ({ command, keys }));

describe("resolveBindings", () => {
  it("normalizes contributed spellings", () => {
    const resolved = resolveBindings(defaults(["a.one", "mod+k"]), new Map());
    expect(resolved.byCommand.get("a.one")).toBe("Mod+K");
    expect(resolved.byKeys.get("Mod+K")).toBe("a.one");
  });

  it("gives a conflicted chord to the first registration and lists both", () => {
    const resolved = resolveBindings(
      defaults(["first.cmd", "Mod+K"], ["second.cmd", "mod+k"]),
      new Map(),
    );
    expect(resolved.byKeys.get("Mod+K")).toBe("first.cmd");
    expect(resolved.byCommand.has("second.cmd")).toBe(false);
    expect(resolved.conflicts).toEqual([
      { keys: "Mod+K", commands: ["first.cmd", "second.cmd"], winner: "first.cmd", userWon: false },
    ]);
  });

  it("lets a user override beat every default, conflict included", () => {
    const resolved = resolveBindings(
      defaults(["palette.open", "Mod+K"], ["other.cmd", "Mod+J"]),
      parseOverrides(["other.cmd=Mod+K"]),
    );
    expect(resolved.byKeys.get("Mod+K")).toBe("other.cmd");
    // The default lost its chord and gets nothing else — it is not silently re-homed.
    expect(resolved.byCommand.has("palette.open")).toBe(false);
    expect(resolved.conflicts[0]).toMatchObject({ winner: "other.cmd", userWon: true });
  });

  it("treats an empty override as a deliberate unbind", () => {
    const resolved = resolveBindings(defaults(["palette.open", "Mod+K"]), parseOverrides(["palette.open="]));
    expect(resolved.byCommand.has("palette.open")).toBe(false);
    expect(resolved.byKeys.has("Mod+K")).toBe(false);
    expect(resolved.overrides.get("palette.open")).toBe("");
  });

  it("keeps one binding per command", () => {
    const resolved = resolveBindings(defaults(["a.one", "Mod+K"], ["a.one", "Mod+J"]), new Map());
    expect(resolved.byCommand.get("a.one")).toBe("Mod+K");
    expect(resolved.byKeys.has("Mod+J")).toBe(false);
  });

  it("drops an unusable default instead of failing the rest", () => {
    const resolved = resolveBindings(defaults(["bad.cmd", "Mod"], ["good.cmd", "Mod+K"]), new Map());
    expect(resolved.byCommand.has("bad.cmd")).toBe(false);
    expect(resolved.byCommand.get("good.cmd")).toBe("Mod+K");
  });

  it("records sequence prefixes so a pending chord can wait", () => {
    const resolved = resolveBindings(defaults(["go.docs", "g d"], ["go.trash", "g t"]), new Map());
    expect(resolved.prefixes.has("G")).toBe(true);
    expect(resolved.byKeys.get("G D")).toBe("go.docs");
    expect(resolved.byKeys.get("G T")).toBe("go.trash");
  });
});

describe("parseOverrides", () => {
  it("round-trips through the stored list form", () => {
    const parsed = parseOverrides(["b.cmd=Mod+J", "a.cmd=mod+k"]);
    expect(serializeOverrides(parsed)).toEqual(["a.cmd=Mod+K", "b.cmd=Mod+J"]);
  });

  it("survives a human editing the settings document badly", () => {
    const parsed = parseOverrides([
      "good.cmd=Mod+K",
      "=Mod+J", // no command
      "no-equals-sign",
      "bad.keys=Mod+A+B", // two keys in one chord
      42,
      null,
    ]);
    expect([...parsed.keys()]).toEqual(["good.cmd"]);
  });

  it("accepts a bare string, because a one-entry YAML list can materialize as one", () => {
    expect(parseOverrides("a.cmd=Mod+K").get("a.cmd")).toBe("Mod+K");
  });
});
