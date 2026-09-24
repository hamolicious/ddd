/**
 * Chord normalization and the platform's `Mod`.
 *
 * These are the cases that make two spellings of one binding either agree or silently
 * diverge, which is the whole reason `keys.ts` exists as pure functions.
 */

import { describe, expect, it } from "vitest";

import {
  chordsOf,
  eventKeys,
  formatKeys,
  isBareChord,
  normalizeKeys,
  parseChord,
} from "./keys.js";

describe("normalizeKeys", () => {
  it("canonicalizes modifier order and case", () => {
    expect(normalizeKeys("mod+k")).toBe("Mod+K");
    expect(normalizeKeys("K+Mod")).toBe("Mod+K");
    expect(normalizeKeys("shift+mod+f")).toBe("Mod+Shift+F");
    expect(normalizeKeys("  CTRL + Shift + p ")).toBe("Ctrl+Shift+P");
  });

  it("keeps the documented spellings from _shared/points.ts stable", () => {
    expect(normalizeKeys("Mod+K")).toBe("Mod+K");
    expect(normalizeKeys("Mod+Shift+F")).toBe("Mod+Shift+F");
    expect(normalizeKeys("Shift+Alt+F")).toBe("Shift+Alt+F");
  });

  it("maps modifier aliases without folding Mod into Ctrl", () => {
    expect(normalizeKeys("cmd+k")).toBe("Meta+K");
    expect(normalizeKeys("ctrl+k")).toBe("Ctrl+K");
    expect(normalizeKeys("option+k")).toBe("Alt+K");
    // `Mod` and `Ctrl` are different bindings on an Apple platform, so they must stay
    // different strings — folding them here is how a Mac user loses Ctrl+K forever.
    expect(normalizeKeys("mod+k")).not.toBe(normalizeKeys("ctrl+k"));
  });

  it("canonicalizes named keys", () => {
    expect(normalizeKeys("esc")).toBe("Escape");
    expect(normalizeKeys("mod+up")).toBe("Mod+ArrowUp");
    expect(normalizeKeys("mod+space")).toBe("Mod+Space");
    expect(normalizeKeys("f5")).toBe("F5");
  });

  it("handles sequences", () => {
    expect(normalizeKeys("g d")).toBe("G D");
    expect(chordsOf(normalizeKeys("g  then"))).toHaveLength(2);
  });

  it("rejects unusable bindings rather than guessing", () => {
    expect(normalizeKeys("")).toBe("");
    expect(normalizeKeys("Mod")).toBe("");
    expect(normalizeKeys("Mod+A+B")).toBe("");
    expect(normalizeKeys("g ")).toBe("G");
  });

  it("parses the + key itself", () => {
    expect(normalizeKeys("Mod++")).toBe("Mod++");
    expect(normalizeKeys("Mod+plus")).toBe("Mod++");
  });
});

describe("isBareChord", () => {
  it("counts Shift-only as bare, because Shift+N is still typing", () => {
    expect(isBareChord(parseChord("N"))).toBe(true);
    expect(isBareChord(parseChord("Shift+N"))).toBe(true);
    expect(isBareChord(parseChord("Mod+N"))).toBe(false);
    expect(isBareChord(parseChord("Alt+N"))).toBe(false);
  });
});

describe("eventKeys", () => {
  const event = (over: Partial<KeyboardEvent>): Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  > => ({ key: "k", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });

  it("maps the platform's primary modifier to Mod", () => {
    expect(eventKeys(event({ ctrlKey: true }), false)).toBe("Mod+K");
    expect(eventKeys(event({ metaKey: true }), true)).toBe("Mod+K");
  });

  it("keeps the secondary modifier distinct", () => {
    // Ctrl on a Mac is literally Ctrl; Meta on Linux is literally Meta.
    expect(eventKeys(event({ ctrlKey: true }), true)).toBe("Ctrl+K");
    expect(eventKeys(event({ metaKey: true }), false)).toBe("Meta+K");
  });

  it("returns nothing for a modifier pressed on its own", () => {
    expect(eventKeys(event({ key: "Control", ctrlKey: true }), false)).toBe("");
    expect(eventKeys(event({ key: "Shift", shiftKey: true }), false)).toBe("");
  });

  it("names the space bar", () => {
    expect(eventKeys(event({ key: " " }), false)).toBe("Space");
  });
});

describe("formatKeys", () => {
  it("uses symbols on Apple platforms and words elsewhere", () => {
    expect(formatKeys("Mod+Shift+K", true)).toBe("⌘⇧K");
    expect(formatKeys("Mod+Shift+K", false)).toBe("Ctrl+Shift+K");
    expect(formatKeys("G D", false)).toBe("G D");
  });
});
