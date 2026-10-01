/** RENAME-HOP: when the old domain moves to the canonical one, and when it waits. Deleted with it. */

import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";

import {
  canonicalOrigin,
  clearOrigin,
  moveTarget,
  runDomainMove,
  settled,
  stillQuiet,
  waitingFor,
  type MoveDeps,
  type Readiness,
} from "./rename-hop-move.js";

const OLD = "https://life.slayhouse.net";
const NEW = "https://ddd.slayhouse.net";
const READY: Readiness = { status: "synced", pending: 0, unsent: 0, uploads: 0, pausedUploads: 0, buffered: 0, legacyDatabases: [] };

/** Thrown by the fake `sleep` to end a run that would otherwise wait for ever. */
class Stop extends Error {}

function setup(overrides: Partial<MoveDeps> & { states?: Readiness[]; confirms?: boolean[]; maxSleeps?: number } = {}) {
  const log: string[] = [];
  const states = overrides.states ?? [READY];
  const confirms = overrides.confirms ?? [true];
  let poll = 0;
  let confirm = 0;
  let sleeps = 0;
  const stranded: string[][] = [];
  const announced: (string | undefined)[] = [];
  const deps: MoveDeps = {
    bootstrap: async () => ({ public_url: NEW, rename_hop_from: [OLD] }),
    origin: OLD,
    shellOwnsSession: false,
    readiness: async () => {
      const state = states[Math.min(poll, states.length - 1)]!;
      poll += 1;
      log.push(`poll:${settled(state) ? "ok" : "wait"}`);
      return state;
    },
    confirm: async () => {
      const ok = confirms[Math.min(confirm, confirms.length - 1)]!;
      confirm += 1;
      log.push(`confirm:${ok ? "ok" : "no"}`);
      return ok;
    },
    announce: (host, waiting) => {
      if (announced.length === 0) log.push(`announce:${host}`);
      announced.push(waiting);
    },
    stranded: (names) => void stranded.push([...names]),
    cleanup: vi.fn(async () => {
      log.push("cleanup");
      return true;
    }),
    move: vi.fn(async (origin: string) => void log.push(`move:${origin}`)),
    sleep: vi.fn(async () => {
      sleeps += 1;
      if (sleeps > (overrides.maxSleeps ?? 50)) throw new Stop("still waiting");
    }),
    warn: () => undefined,
    ...overrides,
  };
  return { deps, log, stranded, announced };
}

describe("rename hop: where to move", () => {
  it("only moves to a different, valid http(s) origin", () => {
    expect(canonicalOrigin(NEW, OLD)).toBe(NEW);
    expect(canonicalOrigin(`${NEW}/`, NEW)).toBeUndefined();
    expect(canonicalOrigin(`${NEW}/app`, OLD)).toBe(NEW);
    expect(canonicalOrigin(null, OLD)).toBeUndefined();
    expect(canonicalOrigin(undefined, OLD)).toBeUndefined();
    expect(canonicalOrigin("not a url", OLD)).toBeUndefined();
    expect(canonicalOrigin("javascript:alert(1)", OLD)).toBeUndefined();
  });

  it("only moves from an origin the server names as an old one", () => {
    expect(moveTarget({ public_url: NEW, rename_hop_from: [OLD] }, OLD)).toBe(NEW);
    expect(moveTarget({ public_url: NEW, rename_hop_from: [`${OLD}/`] }, OLD)).toBe(NEW);
    for (const origin of ["http://192.168.1.20:8080", "http://localhost:5173", "http://127.0.0.1:8080"]) {
      expect(moveTarget({ public_url: NEW, rename_hop_from: [OLD] }, origin)).toBeUndefined();
    }
    // An older server: no list, no move.
    expect(moveTarget({ public_url: NEW }, OLD)).toBeUndefined();
    expect(moveTarget({ public_url: NEW, rename_hop_from: [] }, OLD)).toBeUndefined();
    expect(moveTarget({ public_url: null, rename_hop_from: [OLD] }, OLD)).toBeUndefined();
  });

  it("says what it is waiting for", () => {
    expect(waitingFor({ ...READY, pending: 3, uploads: 1 })).toBe("3 changes and 1 upload still to send");
    expect(waitingFor({ ...READY, unsent: 1, uploads: 2, pausedUploads: 1 })).toBe("1 change and 1 upload still to send and 1 paused upload to resume");
    expect(waitingFor({ ...READY, uploads: 1, pausedUploads: 1 })).toBe("1 paused upload to resume");
    expect(waitingFor({ ...READY, status: "offline", pending: 2 })).toBe("2 changes still to send and a connection to the server");
    expect(waitingFor({ ...READY, status: "auth-required" })).toBe("you to sign in again");
    expect(waitingFor({ ...READY, status: "syncing" })).toBe("the sync to finish");
    expect(waitingFor({ ...READY, buffered: 10 })).toBe("the sync to finish");
    expect(waitingFor({ ...READY, legacyDatabases: ["life-manager"] })).toBe("data from before the rename that could not be moved yet");
    expect(waitingFor(READY)).toBeUndefined();
  });
});

describe("rename hop: the move to the canonical domain", () => {
  it("stays on the canonical origin, on any origin not named as old, with no public_url, and in the Flutter shell", async () => {
    for (const overrides of [
      { origin: NEW },
      { origin: "http://192.168.1.20:8080" },
      { bootstrap: async () => ({ public_url: NEW }) },
      { bootstrap: async () => ({ public_url: NEW, rename_hop_from: [] }) },
      { bootstrap: async () => ({ public_url: null, rename_hop_from: [OLD] }) },
      { shellOwnsSession: true },
    ] satisfies Partial<MoveDeps>[]) {
      const { deps, log } = setup(overrides);
      expect(await runDomainMove(deps)).toBe("stay");
      expect(log).toEqual([]);
    }
  });

  it("moves once settled twice, confirmed by the server and settled once more", async () => {
    const { deps, log } = setup();
    expect(await runDomainMove(deps)).toBe("moved");
    expect(log).toEqual([`announce:ddd.slayhouse.net`, "poll:ok", "poll:ok", "confirm:ok", "poll:ok", "cleanup", `move:${NEW}`]);
  });

  it("waits while anything is unsent, uploading, buffered or not exactly synced, and a blip restarts the count", async () => {
    const { deps, log } = setup({
      states: [
        { ...READY, status: "offline" },
        { ...READY, status: "syncing" },
        { ...READY, pending: 2 },
        READY,
        { ...READY, unsent: 1 },
        READY,
        { ...READY, uploads: 1, pausedUploads: 1 },
        { ...READY, buffered: 512 },
        READY,
        READY,
      ],
    });
    await runDomainMove(deps);
    expect(log.filter((line) => line.startsWith("poll")).slice(0, 10)).toEqual([
      "poll:wait",
      "poll:wait",
      "poll:wait",
      "poll:ok",
      "poll:wait",
      "poll:ok",
      "poll:wait",
      "poll:wait",
      "poll:ok",
      "poll:ok",
    ]);
    expect(log.slice(-2)).toEqual(["cleanup", `move:${NEW}`]);
  });

  it("never moves while sync is only syncing", async () => {
    const { deps, log } = setup({ states: [{ ...READY, status: "syncing" }], maxSleeps: 10 });
    await expect(runDomainMove(deps)).rejects.toBeInstanceOf(Stop);
    expect(log).not.toContain("cleanup");
    expect(deps.move).not.toHaveBeenCalled();
  });

  it("never moves while a database from before the rename is still here, and says so", async () => {
    const { deps, log, stranded, announced } = setup({ states: [{ ...READY, legacyDatabases: ["life-manager"] }], maxSleeps: 10 });
    await expect(runDomainMove(deps)).rejects.toBeInstanceOf(Stop);
    expect(log).not.toContain("confirm:ok");
    expect(log).not.toContain("cleanup");
    expect(stranded.at(-1)).toEqual(["life-manager"]);
    expect(announced.at(-1)).toBe("data from before the rename that could not be moved yet");
  });

  it("clears the stranded notice once the old database is gone, then moves", async () => {
    const { deps, stranded } = setup({ states: [{ ...READY, legacyDatabases: ["life-manager"] }, READY] });
    expect(await runDomainMove(deps)).toBe("moved");
    expect(stranded[0]).toEqual(["life-manager"]);
    expect(stranded.at(-1)).toEqual([]);
  });

  it("never moves while the server cannot confirm receipt", async () => {
    const { deps, log, announced } = setup({ confirms: [false], maxSleeps: 12 });
    await expect(runDomainMove(deps)).rejects.toBeInstanceOf(Stop);
    expect(log.filter((line) => line === "confirm:no").length).toBeGreaterThan(1);
    expect(log).not.toContain("cleanup");
    expect(announced).toContain("the server to confirm it has every change");
  });

  it("checks again after confirming, and backs out when the cleanup's last check fails", async () => {
    let cleanups = 0;
    const { deps, log } = setup({
      states: [READY, READY, { ...READY, pending: 1 }, READY, READY, READY],
      cleanup: vi.fn(async () => {
        cleanups += 1;
        log.push(`cleanup:${cleanups === 1 ? "backed-out" : "done"}`);
        return cleanups > 1;
      }),
    });
    expect(await runDomainMove(deps)).toBe("moved");
    expect(log).toEqual([
      "announce:ddd.slayhouse.net",
      "poll:ok",
      "poll:ok",
      "confirm:ok",
      "poll:wait", // the re-check right before cleanup
      "poll:ok",
      "poll:ok",
      "confirm:ok",
      "poll:ok",
      "cleanup:backed-out",
      "poll:ok",
      "poll:ok",
      "confirm:ok",
      "poll:ok",
      "cleanup:done",
      `move:${NEW}`,
    ]);
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
    expect(calls).toBe(6);
    expect(log).toEqual(["announce:ddd.slayhouse.net", "confirm:ok", "cleanup", `move:${NEW}`]);
  });

  it("asks the server again when it cannot be reached", async () => {
    let calls = 0;
    const { deps } = setup({
      bootstrap: async () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return { public_url: NEW, rename_hop_from: [OLD] };
      },
    });
    expect(await runDomainMove(deps)).toBe("moved");
    expect(calls).toBe(2);
  });
});

describe("rename hop: clearing the old origin", () => {
  it("only clears when nothing changed since the receipt check began", () => {
    const quiet = { confirmedMark: 4, localEdits: 4, status: "synced", pending: 0, buffered: 0 };
    expect(stillQuiet(quiet)).toBe(true);
    expect(stillQuiet({ ...quiet, confirmedMark: undefined })).toBe(false);
    expect(stillQuiet({ ...quiet, localEdits: 5 })).toBe(false);
    expect(stillQuiet({ ...quiet, status: "syncing" })).toBe(false);
    expect(stillQuiet({ ...quiet, pending: 1 })).toBe(false);
    expect(stillQuiet({ ...quiet, buffered: 1 })).toBe(false);
  });

  it("signs out, deletes every database of this origin old and new, drops caches and localStorage", async () => {
    const idb = new IDBFactory();
    for (const name of ["life-manager", "life-manager-search", "life-manager:attachments", "ddd:attachments", "ddd-search", "someone-else"]) {
      await new Promise<void>((resolve, reject) => {
        const request = idb.open(name, 1);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    }
    const log: string[] = [];
    await clearOrigin({
      stopSettings: () => log.push("settings"),
      logout: async () => {
        log.push("logout");
        throw new Error("offline");
      },
      closeEngine: () => log.push("engine"),
      clearReplica: () => log.push("replica"),
      indexedDB: idb,
      dropCaches: async () => void log.push("caches"),
      localStorage: { clear: () => void log.push("localStorage") },
      warn: () => undefined,
    });
    // A failed sign-out does not stop the rest.
    expect(log).toEqual(["settings", "logout", "engine", "replica", "caches", "localStorage"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await idb.databases()).map((db) => db.name)).toEqual(["someone-else"]);
  });
});
