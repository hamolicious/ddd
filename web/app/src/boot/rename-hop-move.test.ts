/** RENAME-HOP: when the old domain moves to the canonical one, and when it waits. Deleted with it. */

import { describe, expect, it, vi } from "vitest";

import { canonicalOrigin, runDomainMove, settled, type MoveDeps, type Readiness } from "./rename-hop-move.js";

const READY: Readiness = { connected: true, pending: 0, unsent: 0, uploads: 0 };

function setup(overrides: Partial<MoveDeps> & { states?: Readiness[] } = {}) {
  const log: string[] = [];
  const states = overrides.states ?? [READY, READY];
  let poll = 0;
  const deps: MoveDeps = {
    publicUrl: async () => "https://ddd.slayhouse.net",
    origin: "https://life.slayhouse.net",
    shellOwnsSession: false,
    readiness: async () => {
      const state = states[Math.min(poll, states.length - 1)]!;
      poll += 1;
      log.push(`poll:${settled(state) ? "ok" : "wait"}`);
      return state;
    },
    announce: (host) => log.push(`announce:${host}`),
    cleanup: vi.fn(async () => void log.push("cleanup")),
    move: vi.fn(async (origin: string) => void log.push(`move:${origin}`)),
    sleep: vi.fn(async () => undefined),
    warn: () => undefined,
    ...overrides,
  };
  return { deps, log };
}

describe("rename hop: the move to the canonical domain", () => {
  it("only moves to a different, valid http(s) origin", () => {
    expect(canonicalOrigin("https://ddd.slayhouse.net", "https://life.slayhouse.net")).toBe("https://ddd.slayhouse.net");
    expect(canonicalOrigin("https://ddd.slayhouse.net/", "https://ddd.slayhouse.net")).toBeUndefined();
    expect(canonicalOrigin("https://ddd.slayhouse.net/app", "https://life.slayhouse.net")).toBe("https://ddd.slayhouse.net");
    expect(canonicalOrigin(null, "https://life.slayhouse.net")).toBeUndefined();
    expect(canonicalOrigin(undefined, "https://life.slayhouse.net")).toBeUndefined();
    expect(canonicalOrigin("not a url", "https://life.slayhouse.net")).toBeUndefined();
    expect(canonicalOrigin("javascript:alert(1)", "https://life.slayhouse.net")).toBeUndefined();
  });

  it("stays on the canonical origin, with no public_url, and in the Flutter shell", async () => {
    for (const overrides of [
      { origin: "https://ddd.slayhouse.net" },
      { publicUrl: async () => null },
      { shellOwnsSession: true },
    ] satisfies Partial<MoveDeps>[]) {
      const { deps, log } = setup(overrides);
      expect(await runDomainMove(deps)).toBe("stay");
      expect(log).toEqual([]);
    }
  });

  it("moves once everything has been settled for two polls in a row", async () => {
    const { deps, log } = setup();
    expect(await runDomainMove(deps)).toBe("moved");
    expect(log).toEqual(["announce:ddd.slayhouse.net", "poll:ok", "poll:ok", "cleanup", "move:https://ddd.slayhouse.net"]);
  });

  it("waits while anything is unsent, offline or uploading, and a blip restarts the count", async () => {
    const { deps, log } = setup({
      states: [
        { ...READY, connected: false },
        { ...READY, pending: 2 },
        READY,
        { ...READY, unsent: 1 },
        READY,
        { ...READY, uploads: 1 },
        READY,
        READY,
      ],
    });
    await runDomainMove(deps);
    expect(log.filter((line) => line.startsWith("poll"))).toEqual([
      "poll:wait",
      "poll:wait",
      "poll:ok",
      "poll:wait",
      "poll:ok",
      "poll:wait",
      "poll:ok",
      "poll:ok",
    ]);
    expect(log.slice(-2)).toEqual(["cleanup", "move:https://ddd.slayhouse.net"]);
  });

  it("keeps waiting, without clearing anything, while readiness cannot be checked", async () => {
    let calls = 0;
    const { deps, log } = setup({
      readiness: async () => {
        calls += 1;
        if (calls <= 3) throw new Error("idb busy");
        return READY;
      },
    });
    await runDomainMove(deps);
    expect(calls).toBe(5);
    expect(log).toEqual(["announce:ddd.slayhouse.net", "cleanup", "move:https://ddd.slayhouse.net"]);
  });

  it("asks the server again when it cannot be reached", async () => {
    let calls = 0;
    const { deps } = setup({
      publicUrl: async () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return "https://ddd.slayhouse.net";
      },
    });
    expect(await runDomainMove(deps)).toBe("moved");
    expect(calls).toBe(2);
  });
});
