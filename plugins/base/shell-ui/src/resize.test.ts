import { afterEach, beforeAll, describe, expect, it } from "vitest";

// This suite runs under node, where `localStorage` does not exist — which is also a
// real browser condition the code guards (private windows). A minimal in-memory stand-in
// lets the round-trip cases assert the storage path; the guard path is the corrupt-value
// case below.
beforeAll(() => {
  if (globalThis.localStorage) return;
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});

import {
  SIDEBAR_DEFAULT,
  SIDEBAR_MIN,
  clampSidebarWidth,
  rememberSidebarWidth,
  sidebarMax,
  storedSidebarWidth,
} from "./resize.js";

afterEach(() => rememberSidebarWidth(undefined));

describe("clampSidebarWidth", () => {
  it("keeps a reasonable drag as asked", () => {
    expect(clampSidebarWidth(340, 1280)).toBe(340);
  });

  it("never goes below the minimum or above half the viewport", () => {
    expect(clampSidebarWidth(40, 1280)).toBe(SIDEBAR_MIN);
    expect(clampSidebarWidth(5000, 1280)).toBe(640);
    expect(sidebarMax(1280)).toBe(640);
  });

  it("a viewport narrower than two minimums still yields a usable floor", () => {
    // min wins over max: the sidebar stays grabbable rather than collapsing to 0.
    expect(clampSidebarWidth(500, 300)).toBe(SIDEBAR_MIN);
  });

  it("garbage becomes the default", () => {
    expect(clampSidebarWidth(Number.NaN, 1280)).toBe(SIDEBAR_DEFAULT);
  });
});

describe("persistence", () => {
  it("round-trips and clears", () => {
    rememberSidebarWidth(333);
    expect(storedSidebarWidth()).toBe(333);
    rememberSidebarWidth(undefined);
    expect(storedSidebarWidth()).toBeUndefined();
  });

  it("ignores a corrupt stored value", () => {
    globalThis.localStorage?.setItem("lm.shell.sidebar-width", "not-a-number");
    expect(storedSidebarWidth()).toBeUndefined();
  });
});
